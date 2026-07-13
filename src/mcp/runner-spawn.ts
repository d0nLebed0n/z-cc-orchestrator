/**
 * Spawn обёртка над CLI для MCP-сервера (T5).
 *
 * Логически повторяет ui-backend/src/process-manager.service.ts, но без NestJS/
 * EventEmitter — тонкий self-contained слой. Сознательное лёгкое дублирование:
 * не рефакторить backend ради MCP (решение проектирования).
 *
 * Контракт: один живой subprocess за раз (как backend). runWorkflow ставит
 * глобальные SIGTERM/SIGINT handlers + in-process mutex на state.json —
 * параллельные запуски в одном процессе запрещены архитектурно.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Путь к cli.ts раннера (src/cli.ts относительно src/mcp/). */
const CLI_PATH = resolve(__dirname, "..", "cli.ts");
/** Корень оркестратора (для cwd spawn'а и загрузки .env.local). */
const ORCHESTRATOR_ROOT = resolve(__dirname, "..", "..");

const TASK_ID_RE = /\bT-[A-Z0-9]{6}\b/;
/** review Д3 (T1-T5): лимит накопленного вывода (ring buffer) — 2 MB на поток. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** review New#4 (T1-T5): workflow name — только basename, без path-компонент. */
const WORKFLOW_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export interface RunnerSession {
  clientKey: string;
  taskId: string | null;
  child: ChildProcess;
  exited: boolean;
  exitCode: number | null;
  success: boolean;
  /** Накопленный вывод (ring buffer, обрезан до MAX_OUTPUT_BYTES). */
  stdout: string;
  stderr: string;
  /**
   * review New#1 (T1-T5): root, где живёт blackboard (state.json) этой задачи.
   * Runner запускается с cwd=ORCHESTRATOR_ROOT, поэтому blackboard там же.
   * get_status по clientKey читает state.json отсюда, а не из target project.
   */
  blackboardRoot: string;
}

const sessions = new Map<string, RunnerSession>();

/** Есть ли живой (не завершившийся) subprocess? */
export function hasAlive(): boolean {
  for (const s of sessions.values()) {
    if (!s.exited) return true;
  }
  return false;
}

/** Активный taskId (или clientKey, если taskId ещё не известен). */
export function activeKey(): string | null {
  for (const s of sessions.values()) {
    if (!s.exited) return s.taskId ?? s.clientKey;
  }
  return null;
}

/** Найти сессию по clientKey или настоящему taskId. */
export function getSession(key: string): RunnerSession | undefined {
  return sessions.get(key) ?? [...sessions.values()].find((s) => s.taskId === key);
}

export interface StartOptions {
  prompt: string;
  workflow: string;
  project: string;
  noCache?: boolean;
  cacheTtlSec?: number;
  noSmartRouting?: boolean;
}

export type StartResult =
  | { ok: true; clientKey: string }
  | { ok: false; reason: "busy"; activeKey: string | null };

/**
 * Запустить воркфлоу как detached subprocess. НЕ блокирует — возвращает clientKey
 * сразу. Один живой процесс за раз. По мере вывода извлекает настоящий taskId.
 */
export function startRunner(opts: StartOptions): StartResult {
  if (hasAlive()) {
    return { ok: false, reason: "busy", activeKey: activeKey() };
  }
  // review New#4 (T1-T5): workflow name — только basename, запрет path traversal.
  if (!WORKFLOW_NAME_RE.test(opts.workflow)) {
    throw new Error(
      `invalid workflow name '${opts.workflow}': must match ^[a-zA-Z0-9_-]+$ (basename only, no path separators)`,
    );
  }

  const clientKey = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const args = [
    "tsx", CLI_PATH, opts.prompt,
    "--workflow", opts.workflow,
    "--project", opts.project,
  ];
  if (opts.noCache) args.push("--no-cache");
  if (opts.cacheTtlSec) args.push("--cache-ttl", String(opts.cacheTtlSec));
  if (opts.noSmartRouting) args.push("--no-smart-routing");

  const child = spawn("npx", args, {
    cwd: ORCHESTRATOR_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true, // process group для kill всего дерева
  });

  const session: RunnerSession = {
    clientKey, taskId: null, child,
    exited: false, exitCode: null, success: false,
    stdout: "", stderr: "",
    // review New#1 (T1-T5): blackboard там, где spawn'ится runner (ORCHESTRATOR_ROOT).
    blackboardRoot: ORCHESTRATOR_ROOT,
  };
  sessions.set(clientKey, session);

  // review Д3 (T1-T5): StringDecoder для склейки многобайтовых символов на границе
  // chunk'ов + ring buffer (обрезка до MAX_OUTPUT_BYTES). taskId ищется по всему
  // декодированному тексту, а не per-chunk (устойчив к разрезанному T-XXXXXX).
  const stdoutDec = new StringDecoder("utf8");
  const stderrDec = new StringDecoder("utf8");
  const appendCapped = (buf: string, text: string): string => {
    const next = buf + text;
    return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = stdoutDec.write(chunk);
    if (!text) return;
    session.stdout = appendCapped(session.stdout, text);
    // taskId ищется по всему накопленному stdout — переживает границу chunk'а.
    if (!session.taskId) {
      const m = session.stdout.match(TASK_ID_RE);
      if (m) session.taskId = m[0];
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = stderrDec.write(chunk);
    if (text) session.stderr = appendCapped(session.stderr, text);
  });
  // flush хвостов StringDecoder при exit.
  const flushStdout = () => { session.stdout = appendCapped(session.stdout, stdoutDec.end()); };
  const flushStderr = () => { session.stderr = appendCapped(session.stderr, stderrDec.end()); };

  child.on("exit", (code) => {
    flushStdout();
    flushStderr();
    session.exited = true;
    session.exitCode = code;
    session.success = code === 0;
    // Удалить сессию через минуту (клиент может дочитывать статус).
    setTimeout(() => sessions.delete(clientKey), 60_000);
  });
  child.on("error", () => {
    flushStdout();
    flushStderr();
    session.exited = true;
    session.success = false;
    setTimeout(() => sessions.delete(clientKey), 60_000);
  });

  return { ok: true, clientKey };
}

/**
 * Запустить CLI-команду и дождаться её завершения (для accept). Блокирует.
 * Возвращает накопленный вывод + exit code.
 */
export async function runOnce(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolveP) => {
    const child = spawn("npx", ["tsx", CLI_PATH, ...args], {
      cwd: opts.cwd ?? ORCHESTRATOR_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.on("exit", (code) => resolveP({ ok: code === 0, code, output }));
    child.on("error", () => resolveP({ ok: false, code: null, output }));
  });
}

/** Остановить активный subprocess (SIGTERM всей process group). */
export function stopRunner(key: string): { ok: boolean; reason?: string } {
  const session = getSession(key);
  if (!session) return { ok: false, reason: "not_found" };
  if (session.exited) return { ok: false, reason: "already_exited" };
  if (session.child.pid == null) return { ok: false, reason: "no_pid" };
  try {
    process.kill(-session.child.pid, "SIGTERM");
  } catch {
    session.child.kill("SIGTERM");
  }
  return { ok: true };
}
