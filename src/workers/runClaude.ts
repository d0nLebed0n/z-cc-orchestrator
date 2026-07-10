/**
 * runClaude — headless-обёртка над `claude` (Claude Code, Anthropic).
 * PLAN §2.3, §2.5.
 *
 * Сигналы успеха для Claude/GLM (§2.5):
 *   1) exit 0
 *   2) непустой last-message (stdout)
 *   3) если роль предполагает правки (implement/refine/fix) — git status непустой
 *
 * Роль plan/review правки не делает → сигнал #3 снимается (has_changes=null).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskEnvelope } from "../envelope.ts";
import type { WorkerFn, WorkerResult } from "./types.ts";
import { runWithTimeout, truncate } from "./spawn.ts";

const execFileAsync = promisify(execFile);

// Runtime-геттер (review #2): env читается при вызове, не при импорте.
const claudeBin = (): string => process.env.CLAUDE_BIN ?? "claude";

/** Роли, которые должны править файлы — для сигнала #3. */
const EDITING_ROLES = new Set(["implement", "refine", "fix"]);

async function gitHasChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export const runClaude: WorkerFn = async (envelope, opts) => {
  // review #3: на ретраях раннер передаёт остаток бюджета, чтобы шаг не
  // превышал wall_time_sec суммарно за все попытки.
  const timeoutSec = opts.wallTimeSecOverride ?? envelope.budget.wall_time_sec;
  const args = [
    "-p", // print/headless режим
    "--output-format",
    "text",
    ...(opts.extraArgs ?? []),
    envelope.prompt,
  ];

  const res = await runWithTimeout(claudeBin(), args, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutSec,
  });

  const output = truncate(res.stdout.trim());
  const hasOutput = output.length > 0;
  const needsEdits = EDITING_ROLES.has(envelope.role);
  const hasChanges = needsEdits ? await gitHasChanges(opts.cwd) : null;

  const signals: WorkerResult["signals"] = [
    { name: "exit_0", ok: res.exit_code === 0, detail: `exit=${res.exit_code}` },
    { name: "nonempty_output", ok: hasOutput, detail: `${output.length} chars` },
  ];
  if (needsEdits) {
    signals.push({ name: "files_changed", ok: hasChanges === true, detail: hasChanges ? "yes" : "no" });
  }

  let reason: WorkerResult["reason"] = null;
  if (res.timed_out) reason = "timeout";
  else if (res.exit_code !== 0) reason = "nonzero_exit";
  else if (!hasOutput) reason = "no_output";
  else if (needsEdits && !hasChanges) reason = "no_changes";

  const success = signals.every((s) => s.ok);

  return {
    exit_ok: res.exit_code === 0,
    exit_code: res.exit_code,
    output,
    timed_out: res.timed_out,
    has_output: hasOutput,
    has_changes: hasChanges,
    signals,
    success,
    reason,
    stderr: truncate(res.stderr.trim()),
    duration_ms: res.duration_ms,
  };
};

export default runClaude;
