/**
 * Хелпер запуска CLI-воркера с таймбоксом и захватом вывода (PLAN §2.3, §4.1).
 *
 * Запускает процесс, ждёт до wall_time_sec, при превышении — SIGTERM затем
 * SIGKILL. Возвращает stdout/stderr/exit_code.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface SpawnResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
}

/**
 * Запустить команду headless с таймбоксом.
 * @param cmd  исполняемый файл (или полный путь)
 * @param args аргументы
 * @param opts cwd, env, timeoutSec, stdin (опц. — review #64: длинный промпт
 *             пайпится через stdin вместо argv, чтобы не упереться в ARG_MAX/E2BIG)
 */
export function runWithTimeout(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutSec: number; stdin?: string },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const env = { ...process.env, ...opts.env };
    let killed = false;
    let resolved = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env,
      // review #64: pipe stdin когда задан opts.stdin, иначе ignore.
      stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      // detached: новая process group (setsid) — child.pid = лидер группы.
      // Позволяет убить ВСЮ группу при таймауте, включая внуков (claude/codex
      // спавнят дочерние процессы, которые иначе переживут SIGKILL head-процесса).
      // review #5.
      detached: true,
    });

    /** Убить всю process group (-pid). Безопасно: ESRCH если группа уже мертва. */
    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // ESRCH — группа уже завершилась; не ошибка.
      }
    };

    // review #64 (review-2026-07-13): длинный промпт через stdin вместо argv.
    // Записываем и закрываем stdin; ошибка (EPIPE если процесс уже вышел) не валит запуск.
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
    }

    let stdout = "";
    let stderr = "";
    // StringDecoder аккумулирует незавершённый многобайтовый хвост до прихода
    // следующего chunk'а — иначе UTF-8 символ на границе chunk повредится (review #C).
    const stdoutDec = new StringDecoder("utf8");
    const stderrDec = new StringDecoder("utf8");
    // Ограничим размер буферов, чтобы не съесть память на больших выводах.
    const MAX = 2 * 1024 * 1024; // 2 MB на поток

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX) stdout += stdoutDec.write(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX) stderr += stderrDec.write(d);
    });

    // review #9: handle для escalation-таймера. Раньше второй setTimeout
    // создавался без сохранения handle — после штатного close его callback
    // обращался к переиспользованному pgid. Теперь оба таймера очищаются
    // единой функцией. .unref() (review #B) — таймеры не держат event loop.
    let escalateTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      killed = true;
      killGroup("SIGTERM");
      // Если за 5 сек группа не умерла — добиваем всю группу.
      escalateTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
      escalateTimer.unref();
    }, opts.timeoutSec * 1000);
    timer.unref();

    /** Единая очистка обоих таймеров. Гарантия однократного resolve (review #9). */
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (escalateTimer) clearTimeout(escalateTimer);
    };
    const finish = (result: SpawnResult): void => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      resolve(result);
    };

    child.on("error", (err) => {
      // Flush хвостов StringDecoder (review #C).
      stdout += stdoutDec.end();
      stderr += stderrDec.end();
      finish({
        exit_code: null,
        stdout,
        stderr: stderr + `\n[spawn error: ${err.message}]`,
        timed_out: killed,
        duration_ms: Date.now() - start,
      });
    });

    child.on("close", (code) => {
      // Flush хвостов StringDecoder (review #C).
      stdout += stdoutDec.end();
      stderr += stderrDec.end();
      finish({
        exit_code: code,
        stdout,
        stderr,
        timed_out: killed,
        duration_ms: Date.now() - start,
      });
    });
  });
}

/**
 * Записать prompt во временный файл и вернуть путь — удобно для CLI,
 * которые принимают промпт файлом, а не аргументом (длинные промпты).
 */
export async function writePromptFile(prompt: string, prefix = "orch-prompt"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const path = join(dir, "prompt.txt");
  await writeFile(path, prompt, "utf8");
  return path;
}

/** Обрезка вывода для хранения в blackboard. */
export function truncate(s: string, max = 8000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated, ${s.length - max} bytes omitted]`;
}
