import { Injectable, Logger } from "@nestjs/common";
import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { PATHS, ORCHESTRATOR_ROOT } from "./config";
import { validateProjectPath, validationMessage } from "./path-utils";

export interface LogLine {
  stream: "stdout" | "stderr";
  line: string;
  ts: string;
}

export interface ProcessSession {
  /** Временный ключ, пока настоящий taskId неизвестен. */
  clientKey: string;
  /** Настоящий taskId, как только раннер его напечатал (T-XXXXXX). */
  taskId: string | null;
  child: ChildProcess;
  /** Кольцевой буфер последних строк для переподключения SSE. */
  buffer: LogLine[];
  exited: boolean;
  exitCode: number | null;
  /** true если завершился успехом (код 0). */
  success: boolean;
  /**
   * Аккумуляторы небезопасной нарезки потока по строкам (review #11).
   * StringDecoder склеивает многобайтовый символ, разрезанный границей chunk'а;
   * lineTail хранит незавершённую строку до прихода следующего '\n'.
   */
  decoders: { stdout: StringDecoder; stderr: StringDecoder };
  lineTail: { stdout: string; stderr: string };
}

export interface StartOptions {
  prompt: string;
  workflow: string;
  project?: string;
}

interface StartResultOk {
  ok: true;
  clientKey: string;
}
interface StartResultConflict {
  ok: false;
  reason: "busy";
  activeTaskId: string | null;
}
interface StartResultInvalid {
  ok: false;
  reason: "invalid_project";
  message: string;
}
export type StartResult = StartResultOk | StartResultConflict | StartResultInvalid;

const TASK_ID_RE = /\bT-[A-Z0-9]{6}\b/;
const MAX_BUFFER = 500;

/**
 * In-memory реестр активных процессов: clientKey → session.
 * clientKey — ключ, под которым фронт подписывается на стрим, до тех пор
 * пока раннер не напечатает настоящий taskId.
 */
@Injectable()
export class ProcessManager extends EventEmitter {
  private readonly logger = new Logger(ProcessManager.name);
  private sessions = new Map<string, ProcessSession>();

  /** Есть ли живой (не завершившийся) subprocess? */
  hasAlive(): boolean {
    for (const s of this.sessions.values()) {
      if (!s.exited) return true;
    }
    return false;
  }

  activeTaskId(): string | null {
    for (const s of this.sessions.values()) {
      if (!s.exited) return s.taskId ?? s.clientKey;
    }
    return null;
  }

  /** Запустить задачу. Один живой subprocess за раз. */
  start(opts: StartOptions): StartResult {
    if (this.hasAlive()) {
      return { ok: false, reason: "busy", activeTaskId: this.activeTaskId() };
    }

    // Валидация пути проекта (если задан явно). По умолчанию — корень оркестратора.
    // Разворачивает ~ и проверяет, что это git-репозиторий.
    let projectPath = ORCHESTRATOR_ROOT;
    if (opts.project && opts.project.trim().length > 0) {
      const v = validateProjectPath(opts.project);
      if (!v.ok) {
        return { ok: false, reason: "invalid_project", message: validationMessage(v) };
      }
      projectPath = v.path;
    }

    const clientKey = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const args = [
      "tsx",
      PATHS.cli,
      opts.prompt,
      "--workflow",
      opts.workflow,
      "--project",
      projectPath,
    ];

    const child = spawn("npx", args, {
      cwd: ORCHESTRATOR_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      // review #4 (Codex): detached → новая process group, чтобы stop() мог
      // убить всё дерево (npx → tsx → раннер → model CLI), а не только head.
      detached: true,
    });

    const session: ProcessSession = {
      clientKey,
      taskId: null,
      child,
      buffer: [],
      exited: false,
      exitCode: null,
      success: false,
      decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
      lineTail: { stdout: "", stderr: "" },
    };
    this.sessions.set(clientKey, session);

    const handleData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      // StringDecoder склеивает многобайтовый символ, разрезанный границей chunk'а,
      // и накапливает хвост — раньше каждый chunk нарезался по '\n' независимо,
      // частичная строка становилась несколькими log entries (review #11).
      const decoded = session.decoders[stream].write(chunk);
      // Присоединяем хвост от предыдущего chunk'а.
      const text = session.lineTail[stream] + decoded;
      const lines = text.split("\n");
      // Последний элемент — незавершённая строка (без завершающего '\n'); оставляем на след. chunk.
      session.lineTail[stream] = lines.pop() ?? "";
      for (const line of lines) {
        // Пустые строки между '\n' пропускаем (как раньше), но реальная пустая строка
        // вывода тоже даёт '' — пропускаем сознательно, log entries только непустые.
        if (line.length === 0) continue;
        const entry: LogLine = { stream, line, ts: new Date().toISOString() };
        session.buffer.push(entry);
        if (session.buffer.length > MAX_BUFFER) session.buffer.shift();

        // Пытаемся извлечь настоящий taskId из первых строк вывода раннера.
        if (!session.taskId) {
          const m = line.match(TASK_ID_RE);
          if (m) {
            session.taskId = m[0];
            this.emit("task-id", { clientKey, taskId: session.taskId });
          }
        }
        this.emit("log", { clientKey, entry });
      }
    };

    child.stdout?.on("data", handleData("stdout"));
    child.stderr?.on("data", handleData("stderr"));

    child.on("exit", (code, signal) => {
      session.exited = true;
      session.exitCode = code;
      session.success = code === 0;
      // Flush остатков StringDecoder + незавершённого хвоста строки (review #11).
      this.flushTail(session, "stdout");
      this.flushTail(session, "stderr");
      this.logger.log(`process ${clientKey} exited code=${code} signal=${signal}`);
      this.emit("exit", { clientKey, code, success: session.success });
      // Не удаляем сессию сразу — фронт может ещё дочитывать. Удаляем по таймауту.
      setTimeout(() => {
        this.sessions.delete(clientKey);
      }, 60_000);
    });

    child.on("error", (err) => {
      this.logger.error(`spawn error: ${err.message}`);
      session.exited = true;
      session.success = false;
      this.emit("exit", { clientKey, code: null, success: false });
    });

    this.logger.log(`started ${clientKey}: workflow=${opts.workflow} project=${projectPath}`);
    return { ok: true, clientKey };
  }

  /** Найти сессию по clientKey или настоящему taskId. */
  get(key: string): ProcessSession | undefined {
    return (
      this.sessions.get(key) ??
      [...this.sessions.values()].find((s) => s.taskId === key)
    );
  }

  /** Остановить subprocess (всю process group — npx/tsx/раннер/model CLI). */
  stop(key: string): { ok: boolean; reason?: string } {
    const session = this.get(key);
    if (!session) return { ok: false, reason: "not_found" };
    if (session.exited) return { ok: false, reason: "already_exited" };
    // review #4 (Codex): убиваем всю process group (-pid), иначе npx умирает,
    // а tsx/раннер/model CLI продолжают работать в фоне. detached:true в spawn
    // делает child.pid лидером группы.
    const killGroup = (sig: NodeJS.Signals): void => {
      if (session.child.pid == null) return;
      try { process.kill(-session.child.pid, sig); }
      catch (e) { // ESRCH — группа уже мертва; fallback на прямой kill.
        session.child.kill(sig);
      }
    };
    killGroup("SIGTERM");
    setTimeout(() => {
      if (!session.exited) {
        this.logger.warn(`force-killing ${key} (process group) after SIGTERM timeout`);
        killGroup("SIGKILL");
      }
    }, 10_000);
    return { ok: true };
  }

  /**
   * Flush остатков StringDecoder + незавершённого хвоста строки при завершении
   * процесса. Эмитит финальную log-line, если что-то осталось (review #11).
   */
  private flushTail(session: ProcessSession, stream: "stdout" | "stderr"): void {
    let rest = session.decoders[stream].end();
    rest = session.lineTail[stream] + rest;
    session.lineTail[stream] = "";
    if (rest.length === 0) return;
    // Возможен trailing '\n' — split даст ['...', ''] — emit только непустые.
    for (const line of rest.split("\n")) {
      if (line.length === 0) continue;
      const entry: LogLine = { stream, line, ts: new Date().toISOString() };
      session.buffer.push(entry);
      if (session.buffer.length > MAX_BUFFER) session.buffer.shift();
      if (!session.taskId) {
        const m = line.match(TASK_ID_RE);
        if (m) {
          session.taskId = m[0];
          this.emit("task-id", { clientKey: session.clientKey, taskId: session.taskId });
        }
      }
      this.emit("log", { clientKey: session.clientKey, entry });
    }
  }

  /**
   * Запустить разовую команду и дождаться её завершения.
   *
   * review #22 (review-2026-07-13): ring buffer (2 MB) + StringDecoder для
   * обоих потоков — раньше output копился без лимита и резался по границе
   * UTF-8 chunk'а. Используется accept'ом и project init.
   */
  async runOnce(args: string[]): Promise<{ ok: boolean; code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn("npx", ["tsx", PATHS.cli, ...args], {
        cwd: ORCHESTRATOR_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const MAX = 2 * 1024 * 1024;
      const stdoutDec = new StringDecoder("utf8");
      const stderrDec = new StringDecoder("utf8");
      let output = "";
      const append = (text: string): void => {
        output += text;
        if (output.length > MAX) output = output.slice(-MAX);
      };
      child.stdout?.on("data", (c: Buffer) => append(stdoutDec.write(c)));
      child.stderr?.on("data", (c: Buffer) => append(stderrDec.write(c)));
      child.on("exit", (code) => {
        append(stdoutDec.end());
        append(stderrDec.end());
        resolve({ ok: code === 0, code, output });
      });
      child.on("error", () => {
        append(stdoutDec.end());
        append(stderrDec.end());
        resolve({ ok: false, code: null, output });
      });
    });
  }
}
