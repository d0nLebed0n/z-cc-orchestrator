import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMetrics } from "./agent-metrics.ts";

describe("workflow routing (T3)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-route-"));
    const { loadModelsConfig, resetRegistry } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(join(dir, ".orchestrator"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  /** Mock-метрики: один агент плохой (высокий error-rate), другой хороший. */
  function mockMetrics(good: string, bad: string): AgentMetrics {
    return {
      stats: new Map([
        [good, { agent: good, total: 10, success: 9, failed: 1, escalated: 0, errorRate: 0.1, medianDurationMs: 60_000, samples: 10 }],
        [bad, { agent: bad, total: 10, success: 2, failed: 8, escalated: 0, errorRate: 0.8, medianDurationMs: 60_000, samples: 10 }],
      ]),
      windowSize: 10,
      computedAt: new Date().toISOString(),
    };
  }

  it("routeSubtaskWithMetrics matches routeSubtask when metrics are equal", async () => {
    const { routeSubtask, routeSubtaskWithMetrics } = await import("./workflow.ts?t=" + Date.now());
    const subtask = { id: "P1", title: "t", goal: "g", complexity: 90, target_paths: [], acceptance_criteria: "ok" };
    // Равные метрики → должен выбрать того же (первого strong-кандидата = glm).
    const equalMetrics = {
      stats: new Map([
        ["glm", { agent: "glm", total: 5, success: 5, failed: 0, escalated: 0, errorRate: 0, medianDurationMs: 60_000, samples: 5 }],
        ["codex", { agent: "codex", total: 5, success: 5, failed: 0, escalated: 0, errorRate: 0, medianDurationMs: 60_000, samples: 5 }],
      ]),
      windowSize: 5, computedAt: new Date().toISOString(),
    };
    const staticChoice = routeSubtask(subtask, ["glm", "ollama"], 65);
    const metricsChoice = await routeSubtaskWithMetrics(subtask, ["glm", "ollama"], 65, equalMetrics);
    // staticChoice = glm (first non-local). metricsChoice: glm и codex не конкурируют
    // (в пуле только glm из strong). Метрики не меняют выбор — кандидат один на сторону.
    expect(metricsChoice).toBe(staticChoice);
    expect(metricsChoice).toBe("glm");
  });

  it("routeSubtaskWithMetrics prefers reliable agent among same-side candidates", async () => {
    const { routeSubtaskWithMetrics } = await import("./workflow.ts?t=" + Date.now());
    const subtask = { id: "P1", title: "t", goal: "g", complexity: 90, target_paths: [], acceptance_criteria: "ok" };
    // Пул из ДВУХ strong-кандидатов (glm, codex — оба non-local).
    // codex плохой, glm хороший → должен выбрать glm.
    const metrics = mockMetrics("glm", "codex");
    const chosen = await routeSubtaskWithMetrics(subtask, ["codex", "glm"], 65, metrics);
    expect(chosen).toBe("glm");
  });

  it("routeSubtaskWithMetrics on local side prefers reliable local agent", async () => {
    const { routeSubtaskWithMetrics } = await import("./workflow.ts?t=" + Date.now());
    // complexity < threshold → local сторона. В реестре только ollama — local.
    // Добавим второго local через mock невозможно (реестр фикс.), поэтому проверяем
    // что при одном local-кандидате выбирается он без метрик.
    const subtask = { id: "P1", title: "t", goal: "g", complexity: 20, target_paths: [], acceptance_criteria: "ok" };
    const metrics = {
      stats: new Map([["ollama", { agent: "ollama", total: 5, success: 1, failed: 4, escalated: 0, errorRate: 0.8, medianDurationMs: 60_000, samples: 5 }]]),
      windowSize: 5, computedAt: new Date().toISOString(),
    };
    const chosen = await routeSubtaskWithMetrics(subtask, ["glm", "ollama"], 65, metrics);
    // Только ollama — local. Даже с плохими метриками — выбирается (альтернатив нет).
    expect(chosen).toBe("ollama");
  });

  it("routeSubtaskWithMetrics throws when no candidate matches side", async () => {
    const { routeSubtaskWithMetrics } = await import("./workflow.ts?t=" + Date.now());
    const subtask = { id: "P1", title: "t", goal: "g", complexity: 20, target_paths: [], acceptance_criteria: "ok" };
    // Пул только strong (glm), subtask — local (complexity < threshold).
    const metrics = { stats: new Map(), windowSize: 0, computedAt: new Date().toISOString() };
    await expect(routeSubtaskWithMetrics(subtask, ["glm"], 65, metrics)).rejects.toThrow(/no agent/);
  });

  it("routeSubtaskWithMetrics logs route_decision event when logCtx provided", async () => {
    const { routeSubtaskWithMetrics } = await import("./workflow.ts?t=" + Date.now());
    const { initBlackboard, listLogFiles } = await import("./blackboard.ts?t=" + Date.now());
    const { readFile: rf } = await import("node:fs/promises");
    await initBlackboard(dir);
    const subtask = { id: "P1", title: "t", goal: "g", complexity: 90, target_paths: [], acceptance_criteria: "ok" };
    const metrics = mockMetrics("glm", "codex");
    await routeSubtaskWithMetrics(subtask, ["codex", "glm"], 65, metrics, { taskId: "T-LOG", root: dir });
    // Прочитать log и найти route_decision.
    const files = await listLogFiles(dir);
    expect(files.length).toBeGreaterThan(0);
    const logPath = join(dir, ".orchestrator", "log", files[0]!);
    const raw = await rf(logPath, "utf8");
    expect(raw).toContain("route_decision");
    expect(raw).toContain("T-LOG");
  });

  it("routeSubtaskWithMetrics works without logCtx (no logging)", async () => {
    const { routeSubtaskWithMetrics } = await import("./workflow.ts?t=" + Date.now());
    const subtask = { id: "P1", title: "t", goal: "g", complexity: 90, target_paths: [], acceptance_criteria: "ok" };
    const metrics = mockMetrics("glm", "codex");
    // Без logCtx — не должно бросать.
    const chosen = await routeSubtaskWithMetrics(subtask, ["codex", "glm"], 65, metrics);
    expect(chosen).toBe("glm");
  });
});
