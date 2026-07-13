import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("agent-metrics", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-metrics-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Хелпер: создать задачу с шагами разных агентов. */
  async function seedTask(
    taskId: string,
    updatedAt: string,
    steps: Array<{ agent: string; status: "success" | "failed" | "escalated_hitl"; startedAt?: string; finishedAt?: string }>,
  ): Promise<void> {
    const { createTask, upsertStep, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: taskId, prompt: "p", workflow: "w", project: dir, root: dir });
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      await upsertStep(taskId, {
        id: `${taskId}-S${String(i + 1).padStart(2, "0")}`,
        task_id: taskId, agent: s.agent, family: "local", role: "implement",
        status: s.status, started_at: s.startedAt ?? null, finished_at: s.finishedAt ?? null,
        attempts: 1, result_path: null, error: null,
      }, dir);
    }
    // Поставить updated_at вручную — listTasks сортирует по нему для окна.
    const { readFile, writeFile } = await import("node:fs/promises");
    const statePath = join(dir, ".orchestrator", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const t = state.tasks.find((x: { id: string }) => x.id === taskId);
    if (t) t.updated_at = updatedAt;
    await writeFile(statePath, JSON.stringify(state, null, 2));
  }

  it("loadAgentMetrics aggregates counts and errorRate per agent", async () => {
    const { loadAgentMetrics } = await import("./agent-metrics.ts?t=" + Date.now());
    await seedTask("T-A", "2026-07-13T10:00:00Z", [
      { agent: "glm", status: "success" },
      { agent: "glm", status: "failed" },
      { agent: "ollama", status: "success" },
      { agent: "ollama", status: "success" },
    ]);
    const m = await loadAgentMetrics(dir, 0);
    const glm = m.stats.get("glm")!;
    expect(glm.total).toBe(2);
    expect(glm.success).toBe(1);
    expect(glm.failed).toBe(1);
    expect(glm.errorRate).toBeCloseTo(0.5, 5);
    const ollama = m.stats.get("ollama")!;
    expect(ollama.total).toBe(2);
    expect(ollama.errorRate).toBe(0);
  });

  it("loadAgentMetrics counts escalated_hitl as failure", async () => {
    const { loadAgentMetrics } = await import("./agent-metrics.ts?t=" + Date.now());
    await seedTask("T-E", "2026-07-13T10:00:00Z", [
      { agent: "glm", status: "escalated_hitl" },
    ]);
    const m = await loadAgentMetrics(dir, 0);
    const glm = m.stats.get("glm")!;
    expect(glm.escalated).toBe(1);
    expect(glm.errorRate).toBe(1);
  });

  it("loadAgentMetrics ignores pending/running steps", async () => {
    const { loadAgentMetrics } = await import("./agent-metrics.ts?t=" + Date.now());
    const { createTask, upsertStep, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
    await initBlackboard(dir);
    await createTask({ id: "T-P", prompt: "p", workflow: "w", project: dir, root: dir });
    await upsertStep("T-P", {
      id: "T-P-S01", task_id: "T-P", agent: "glm", family: "local", role: "implement",
      status: "running", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
    }, dir);
    const m = await loadAgentMetrics(dir, 0);
    // running не считается — glm отсутствует или total=0.
    const glm = m.stats.get("glm");
    expect(glm?.total ?? 0).toBe(0);
  });

  it("loadAgentMetrics computes medianDurationMs from timing", async () => {
    const { loadAgentMetrics } = await import("./agent-metrics.ts?t=" + Date.now());
    await seedTask("T-D", "2026-07-13T10:00:00Z", [
      { agent: "glm", status: "success", startedAt: "2026-07-13T10:00:00Z", finishedAt: "2026-07-13T10:01:00Z" }, // 60s
      { agent: "glm", status: "success", startedAt: "2026-07-13T11:00:00Z", finishedAt: "2026-07-13T11:00:30Z" }, // 30s
      { agent: "glm", status: "success", startedAt: "2026-07-13T12:00:00Z", finishedAt: "2026-07-13T12:00:45Z" }, // 45s
    ]);
    const m = await loadAgentMetrics(dir, 0);
    const glm = m.stats.get("glm")!;
    expect(glm.samples).toBe(3);
    // Медиана [30s, 45s, 60s] = 45s = 45000ms.
    expect(glm.medianDurationMs).toBe(45_000);
  });

  it("loadAgentMetrics respects recentTasks window", async () => {
    const { loadAgentMetrics } = await import("./agent-metrics.ts?t=" + Date.now());
    // 3 задачи; окно = 2 (последние по updated_at).
    await seedTask("T-OLD", "2026-07-10T10:00:00Z", [{ agent: "glm", status: "success" }]);
    await seedTask("T-MID", "2026-07-11T10:00:00Z", [{ agent: "glm", status: "failed" }]);
    await seedTask("T-NEW", "2026-07-12T10:00:00Z", [{ agent: "ollama", status: "success" }]);
    const m = await loadAgentMetrics(dir, 2);
    expect(m.windowSize).toBe(2);
    // T-OLD не в окне — glm из T-OLD не учтён. glm есть только в T-MID (failed).
    const glm = m.stats.get("glm")!;
    expect(glm.total).toBe(1);
    expect(glm.failed).toBe(1);
    // ollama из T-NEW в окне.
    expect(m.stats.get("ollama")!.total).toBe(1);
  });

  it("scoreAgent returns 0 for undefined stats (new agent, neutral)", async () => {
    const { scoreAgent } = await import("./agent-metrics.ts?t=" + Date.now());
    expect(scoreAgent(undefined)).toBe(0);
  });

  it("scoreAgent: errorRate dominates latency", async () => {
    const { scoreAgent } = await import("./agent-metrics.ts?t=" + Date.now());
    // Высокий error-rate, низкая latency vs низкий error-rate, высокая latency.
    const fastButUnreliable = { agent: "a", total: 10, success: 5, failed: 5, escalated: 0, errorRate: 0.5, medianDurationMs: 1_000, samples: 10 };
    const slowButReliable = { agent: "b", total: 10, success: 9, failed: 1, escalated: 0, errorRate: 0.1, medianDurationMs: 300_000, samples: 10 };
    expect(scoreAgent(fastButUnreliable)).toBeGreaterThan(scoreAgent(slowButReliable));
  });

  it("scoreAgent: lower latency wins at equal errorRate", async () => {
    const { scoreAgent } = await import("./agent-metrics.ts?t=" + Date.now());
    const a = { agent: "a", total: 10, success: 10, failed: 0, escalated: 0, errorRate: 0, medianDurationMs: 60_000, samples: 10 };
    const b = { agent: "b", total: 10, success: 10, failed: 0, escalated: 0, errorRate: 0, medianDurationMs: 180_000, samples: 10 };
    expect(scoreAgent(a)).toBeLessThan(scoreAgent(b));
  });

  it("scoreAgent: handles null medianDurationMs (no latency tiebreak)", async () => {
    const { scoreAgent } = await import("./agent-metrics.ts?t=" + Date.now());
    const noTiming = { agent: "a", total: 5, success: 4, failed: 1, escalated: 0, errorRate: 0.2, medianDurationMs: null, samples: 0 };
    // errorRate*1000 + 0 (latency) = 200.
    expect(scoreAgent(noTiming)).toBe(200);
  });
});
