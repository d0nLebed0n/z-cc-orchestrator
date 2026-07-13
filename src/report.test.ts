import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

describe("report", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-report-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Хелпер: создать в dir git-репо с base + одним изменением на ветке. */
  function freshRepoWithDiff(): { baseSha: string; branch: string } {
    const sh = (args: string[], cwd = dir) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    sh(["init", "-q", "-b", "main"]);
    sh(["config", "user.email", "t@t.t"]);
    sh(["config", "user.name", "t"]);
    writeFileSync(join(dir, "base.txt"), "base\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
    const baseSha = sh(["rev-parse", "HEAD"]).trim();
    // Новая ветка с правкой.
    sh(["checkout", "-q", "-b", "orch/T-TEST/integration"]);
    writeFileSync(join(dir, "new.txt"), "new content line\n");
    writeFileSync(join(dir, "base.txt"), "base\nchanged\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "task work"]);
    return { baseSha, branch: "orch/T-TEST/integration" };
  }

  it("extractVerdict parses APPROVE/REJECT/REQUEST_CHANGES/ACCEPT", async () => {
    const { extractVerdict } = await import("./report.ts?t=" + Date.now());
    expect(extractVerdict("## Review\nVERDICT: APPROVE")).toBe("APPROVE");
    expect(extractVerdict("VERDICT: REJECT\nreasons...")).toBe("REJECT");
    expect(extractVerdict("verdict: request_changes")).toBe("REQUEST_CHANGES");
    expect(extractVerdict("VERDICT: ACCEPT")).toBe("ACCEPT");
    expect(extractVerdict("no verdict here")).toBeNull();
  });

  it("generateReport aggregates step durations from started_at/finished_at", async () => {
    const { createTask, upsertStep, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
    const { generateReport } = await import("./report.ts?t=" + Date.now());
    await initBlackboard(dir);
    const task = await createTask({ id: "T-DUR", prompt: "p", workflow: "w", project: dir, root: dir });
    const start = "2026-07-13T10:00:00.000Z";
    const mid = "2026-07-13T10:00:30.000Z";
    const end = "2026-07-13T10:01:00.000Z";
    await upsertStep("T-DUR", {
      id: "T-DUR-S01", task_id: "T-DUR", agent: "claude", family: "anthropic", role: "plan",
      status: "success", started_at: start, finished_at: mid, attempts: 1, result_path: null, error: null,
    }, dir);
    await upsertStep("T-DUR", {
      id: "T-DUR-S02", task_id: "T-DUR", agent: "glm", family: "zai", role: "implement",
      status: "success", started_at: mid, finished_at: end, attempts: 2, result_path: null, error: null,
    }, dir);
    const report = await generateReport("T-DUR", dir);
    expect(report.started_at).toBe(start);
    expect(report.finished_at).toBe(end);
    // 30s для S01 + 30s для S02 = 60000 ms.
    expect(report.total_duration_ms).toBe(60_000);
    // attempts: 1 + 2 = 3.
    expect(report.total_attempts).toBe(3);
    expect(report.steps).toHaveLength(2);
    expect(report.steps[0]!.duration_ms).toBe(30_000);
  });

  it("generateReport extracts verdict from review step sidecar", async () => {
    const { createTask, upsertStep, initBlackboard, writeResult } = await import("./blackboard.ts?t=" + Date.now());
    const { generateReport } = await import("./report.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: "T-RV", prompt: "p", workflow: "w", project: dir, root: dir });
    await upsertStep("T-RV", {
      id: "T-RV-S01", task_id: "T-RV", agent: "codex", family: "openai", role: "review",
      status: "success", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
    }, dir);
    await writeResult("T-RV", "T-RV-S01", {
      envelope_id: "T-RV-S01", agent: "codex", role: "review",
      output: "## Review\nGood work.\nVERDICT: APPROVE",
      signals: [], success: true, reason: null, duration_ms: 5000, timed_out: false,
    }, dir);
    const report = await generateReport("T-RV", dir);
    expect(report.steps[0]!.verdict).toBe("APPROVE");
    expect(report.steps[0]!.worker_duration_ms).toBe(5000);
  });

  it("generateReport aggregates escalated_reasons from log events", async () => {
    const { createTask, initBlackboard, logEvent } = await import("./blackboard.ts?t=" + Date.now());
    const { generateReport } = await import("./report.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: "T-ESC", prompt: "p", workflow: "w", project: dir, root: dir });
    await logEvent({ task_id: "T-ESC", step_id: "T-ESC-S01", level: "error", kind: "hitl_escalation", message: "breaker tripped" }, dir);
    await logEvent({ task_id: "T-ESC", step_id: "T-ESC-S02", level: "error", kind: "merge_conflict", message: "conflict" }, dir);
    await logEvent({ task_id: "T-ESC", step_id: null, level: "info", kind: "cache_hit", message: "hit" }, dir);
    // Чужая задача — не должна попасть.
    await logEvent({ task_id: "T-OTHER", step_id: null, level: "error", kind: "hitl_escalation", message: "x" }, dir);
    const report = await generateReport("T-ESC", dir);
    expect(report.escalated_reasons).toContain("hitl_escalation");
    expect(report.escalated_reasons).toContain("merge_conflict");
    expect(report.escalated_reasons).not.toContain("cache_hit"); // info-level, не warn/error
    expect(report.cache_hits).toBe(1);
  });

  it("generateReport counts cache_hits from log events", async () => {
    const { createTask, initBlackboard, logEvent } = await import("./blackboard.ts?t=" + Date.now());
    const { generateReport } = await import("./report.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: "T-CH", prompt: "p", workflow: "w", project: dir, root: dir });
    await logEvent({ task_id: "T-CH", step_id: "T-CH-S01", level: "info", kind: "cache_hit", message: "hit 1" }, dir);
    await logEvent({ task_id: "T-CH", step_id: "T-CH-S02", level: "info", kind: "cache_hit", message: "hit 2" }, dir);
    const report = await generateReport("T-CH", dir);
    expect(report.cache_hits).toBe(2);
  });

  it("generateReport marks failed_steps for failed/escalated steps", async () => {
    const { createTask, upsertStep, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
    const { generateReport } = await import("./report.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: "T-FAIL", prompt: "p", workflow: "w", project: dir, root: dir });
    await upsertStep("T-FAIL", {
      id: "T-FAIL-S01", task_id: "T-FAIL", agent: "glm", family: "zai", role: "implement",
      status: "failed", started_at: null, finished_at: null, attempts: 3, result_path: null, error: "boom",
    }, dir);
    await upsertStep("T-FAIL", {
      id: "T-FAIL-S02", task_id: "T-FAIL", agent: "codex", family: "openai", role: "review",
      status: "escalated_hitl", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
    }, dir);
    await upsertStep("T-FAIL", {
      id: "T-FAIL-S03", task_id: "T-FAIL", agent: "claude", family: "anthropic", role: "plan",
      status: "success", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
    }, dir);
    const report = await generateReport("T-FAIL", dir);
    expect(report.failed_steps).toContain("T-FAIL-S01");
    expect(report.failed_steps).toContain("T-FAIL-S02");
    expect(report.failed_steps).not.toContain("T-FAIL-S03");
  });

  it("generateReport parses fan-out subtask + loop iteration from stepId", async () => {
    const { createTask, upsertStep, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
    const { generateReport } = await import("./report.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: "T-SEG", prompt: "p", workflow: "w", project: dir, root: dir });
    await upsertStep("T-SEG", {
      id: "T-SEG-S02~P1", task_id: "T-SEG", agent: "ollama", family: "local", role: "implement",
      status: "success", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
    }, dir);
    await upsertStep("T-SEG", {
      id: "T-SEG-S03#2", task_id: "T-SEG", agent: "claude", family: "anthropic", role: "review",
      status: "success", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
    }, dir);
    const report = await generateReport("T-SEG", dir);
    const fanout = report.steps.find((s: { step_id: string }) => s.step_id === "T-SEG-S02~P1")!;
    expect(fanout.subtask).toBe("P1");
    expect(fanout.iteration).toBeNull();
    const loopStep = report.steps.find((s: { step_id: string }) => s.step_id === "T-SEG-S03#2")!;
    expect(loopStep.iteration).toBe(2);
    expect(loopStep.subtask).toBeNull();
  });

  it("generateReport computes diff insertions/deletions from git numstat", async () => {
    const { createTask, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
    const { generateReport } = await import("./report.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: "T-DIFF", prompt: "p", workflow: "w", project: dir, root: dir });
    const { baseSha, branch } = freshRepoWithDiff();
    const report = await generateReport("T-DIFF", dir, {
      changedFiles: ["new.txt", "base.txt"],
      baseSha,
      integrationBranch: branch,
    });
    expect(report.diff_files_count).toBe(2);
    // new.txt: +1 insertion; base.txt: +1 ins ("changed"), 0 del ("base" осталась) → ins=2, del=0.
    expect(report.diff_insertions).toBe(2);
    expect(report.diff_deletions).toBe(0);
  });

  it("writeReport → readReport round-trips", async () => {
    const { writeReport, readReport, reportPath } = await import("./report.ts?t=" + Date.now());
    const report = {
      task_id: "T-RT", prompt: "p", workflow: "w", project: dir, status: "done" as const, success: true,
      started_at: null, finished_at: null, total_duration_ms: null,
      steps: [], total_attempts: 0, failed_steps: [], escalated_reasons: [],
      diff_files: [], diff_files_count: 0, cache_hits: 0, generated_at: new Date().toISOString(),
    };
    const path = await writeReport(report, dir);
    expect(path).toBe(reportPath("T-RT", dir));
    const back = await readReport("T-RT", dir);
    expect(back).not.toBeNull();
    expect(back!.task_id).toBe("T-RT");
    expect(back!.status).toBe("done");
  });

  it("readReport returns null for missing task", async () => {
    const { readReport } = await import("./report.ts?t=" + Date.now());
    const back = await readReport("T-NONEXIST", dir);
    expect(back).toBeNull();
  });

  it("generateReport does not throw on missing sidecar (defensive)", async () => {
    const { createTask, upsertStep, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
    const { generateReport } = await import("./report.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: "T-NOS", prompt: "p", workflow: "w", project: dir, root: dir });
    await upsertStep("T-NOS", {
      id: "T-NOS-S01", task_id: "T-NOS", agent: "claude", family: "anthropic", role: "plan",
      status: "success", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
    }, dir);
    // Нет sidecar'a — не должно бросать, verdict=null, worker_duration_ms=null.
    const report = await generateReport("T-NOS", dir);
    expect(report.steps[0]!.verdict).toBeNull();
    expect(report.steps[0]!.worker_duration_ms).toBeNull();
  });
});
