/**
 * runCodex — headless-обёртка над `codex` (OpenAI Codex CLI 0.142.5).
 * PLAN §2.3, §2.5, §5.
 *
 * Успех Codex = ТРИ сигнала (все обязательны):
 *   1) exit 0
 *   2) turn.completed в JSONL-выводе (--json)
 *   3) sidecar-файл последнего сообщения (--output-last-message)
 *
 * Ключевые флаги (codex 0.142.5 — флаг -a never УСТАРЕЛ):
 *   -s workspace-write           — sandbox: писать в workspace (для npm install
 *                                  добавить -c sandbox_permissions с network)
 *   --skip-git-repo-check        — worktree может быть вне основного репо
 *   --json                       — стримить события в JSONL (сигнал #2)
 *   -o/--output-last-message F   — sidecar-файл (сигнал #3)
 *
 * Бинарник codex: на macOS-приложении путь /Applications/Codex.app/.../codex
 * (см. docs/decisions.md). Переопределяется env CODEX_BIN.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskEnvelope } from "../envelope.ts";
import type { WorkerFn, WorkerResult } from "./types.ts";
import { runWithTimeout, truncate } from "./spawn.ts";

const execFileAsync = promisify(execFile);

// Codex CLI: OpenAI влил standalone Codex.app в ChatGPT.app (версия 0.144.0+).
// Старый путь /Applications/Codex.app/.../codex больше не существует.
// Переопределяется env CODEX_BIN (см. .env.local, docs/versions.md).
const CODEX_BIN =
  process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex";

async function gitHasChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export const runCodex: WorkerFn = async (envelope, opts) => {
  // review #3: на ретраях раннер передаёт остаток бюджета шага.
  const wallSec = opts.wallTimeSecOverride ?? envelope.budget.wall_time_sec;
  const timeoutSec = Math.min(
    wallSec,
    (envelope.budget.max_session_min ?? 25) * 60,
  );

  // codex 0.142.5: флаг -a never УСТАРЕЛ. Используем -s workspace-write
  // (sandbox позволяет писать в workspace) + --skip-git-repo-check (наш worktree
  // может быть вне основного репо). network_access для npm install задаётся
  // через -c sandbox_permissions (см. docs/versions.md).
  // sidecar-файл (сигнал #3): --output-last-message пишет last-message на диск.
  const lastMsgFile = await (async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = await mkdtemp(join(tmpdir(), "codex-lastmsg-"));
    return join(d, "last-message.txt");
  })();

  const args = [
    "exec",
    "-s", "workspace-write",
    "--skip-git-repo-check",
    "--json",
    "-o", lastMsgFile,
    ...(opts.extraArgs ?? []),
    "--",
    envelope.prompt,
  ];

  const res = await runWithTimeout(CODEX_BIN, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutSec,
  });

  const stdout = res.stdout;
  const stderr = res.stderr;

  // Сигнал #2: turn.completed в JSONL-потоке.
  const hasTurnCompleted = /"turn\.completed"/.test(stdout);

  // Сигнал #3: sidecar-файл результата (--output-last-message). Читаем его.
  let sidecarContent = "";
  try {
    const { readFile } = await import("node:fs/promises");
    sidecarContent = (await readFile(lastMsgFile, "utf8")).trim();
  } catch {
    // файла нет — сигнал провален
  }
  const hasOutput = sidecarContent.length > 0;

  const needsEdits = ["implement", "refine", "fix"].includes(envelope.role);
  const hasChanges = needsEdits ? await gitHasChanges(opts.cwd) : null;

  const signals: WorkerResult["signals"] = [
    { name: "exit_0", ok: res.exit_code === 0, detail: `exit=${res.exit_code}` },
    { name: "turn_completed", ok: hasTurnCompleted, detail: hasTurnCompleted ? "found" : "missing" },
    { name: "sidecar_output", ok: hasOutput, detail: `${sidecarContent.length} chars` },
  ];
  if (needsEdits) {
    signals.push({ name: "files_changed", ok: hasChanges === true, detail: hasChanges ? "yes" : "no" });
  }

  let reason: WorkerResult["reason"] = null;
  if (res.timed_out) reason = "timeout";
  else if (res.exit_code !== 0) reason = "nonzero_exit";
  else if (!hasTurnCompleted) reason = "no_output";
  else if (!hasOutput) reason = "no_output";

  const success = signals.filter((s) => s.name !== "files_changed").every((s) => s.ok) &&
    (!needsEdits || hasChanges === true);

  return {
    exit_ok: res.exit_code === 0,
    exit_code: res.exit_code,
    output: truncate(sidecarContent || stdout),
    timed_out: res.timed_out,
    has_output: hasOutput,
    has_changes: hasChanges,
    signals,
    success,
    reason,
    stderr: truncate(stderr),
    duration_ms: res.duration_ms,
  };
};

export default runCodex;
