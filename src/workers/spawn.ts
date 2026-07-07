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
 * @param opts cwd, env, timeoutSec
 */
export function runWithTimeout(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutSec: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const env = { ...process.env, ...opts.env };
    let killed = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // не наследовать tty — headless
    });

    let stdout = "";
    let stderr = "";
    // Ограничим размер буферов, чтобы не съесть память на больших выводах.
    const MAX = 2 * 1024 * 1024; // 2 MB на поток

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX) stderr += d.toString("utf8");
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // Если за 5 сек не умер — добиваем.
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, opts.timeoutSec * 1000);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exit_code: null,
        stdout,
        stderr: stderr + `\n[spawn error: ${err.message}]`,
        timed_out: killed,
        duration_ms: Date.now() - start,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
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
