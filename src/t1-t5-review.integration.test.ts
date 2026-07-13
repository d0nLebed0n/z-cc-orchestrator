/**
 * Интеграционные тесты T1-T5 review, не покрытые unit-тестами:
 *   New#2 — cache hit (source="cache") исключается из agent-metrics
 *   New#3 — recordTaskMemory идемпотентен на повторном вызове
 *   #6    — memory search по русскому запросу
 *   Д1    — projectIdFromPath нормализует symlink/trailing slash
 *
 * Требуют реального blackboard + sqlite, поэтому temp-dir + реальный fs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("T1-T5 review integration", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-t1t5-int-"));
    dbPath = join(dir, "knowledge.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("agent-metrics: exclude cache hit (New#2)", () => {
    it("шаг с source=cache НЕ учитывается в надёжности/latency", async () => {
      const { loadAgentMetrics } = await import("./agent-metrics.ts?t=" + Date.now());
      const { createTask, upsertStep, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
      await initBlackboard(dir);
      await createTask({ id: "T-MC", prompt: "p", workflow: "w", project: dir, root: dir });
      // Реальный вызов: success + 60s.
      await upsertStep("T-MC", {
        id: "T-MC-S01", task_id: "T-MC", agent: "glm", family: "zai", role: "implement",
        status: "success", started_at: "2026-07-13T10:00:00Z", finished_at: "2026-07-13T10:01:00Z",
        attempts: 1, result_path: null, error: null, source: "worker",
      }, dir);
      // Cache hit: success + 0.01s (должен быть исключён).
      await upsertStep("T-MC", {
        id: "T-MC-S02", task_id: "T-MC", agent: "glm", family: "zai", role: "implement",
        status: "success", started_at: "2026-07-13T10:02:00Z", finished_at: "2026-07-13T10:02:00.010Z",
        attempts: 1, result_path: null, error: null, source: "cache",
      }, dir);
      const m = await loadAgentMetrics(dir, 0);
      const glm = m.stats.get("glm")!;
      // Только worker-шаг учтён: total=1 (не 2).
      expect(glm.total).toBe(1);
      // Latency = 60s, не 0.01s.
      expect(glm.medianDurationMs).toBe(60_000);
    });

    it("шаг без source (старый state.json) считается worker", async () => {
      const { loadAgentMetrics } = await import("./agent-metrics.ts?t=" + Date.now());
      const { createTask, upsertStep, initBlackboard } = await import("./blackboard.ts?t=" + Date.now());
      await initBlackboard(dir);
      await createTask({ id: "T-LEG", prompt: "p", workflow: "w", project: dir, root: dir });
      await upsertStep("T-LEG", {
        id: "T-LEG-S01", task_id: "T-LEG", agent: "glm", family: "zai", role: "implement",
        status: "success", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
        // source НЕ задан — обратная совместимость.
      }, dir);
      const m = await loadAgentMetrics(dir, 0);
      const glm = m.stats.get("glm")!;
      expect(glm.total).toBe(1);
    });
  });

  describe("memory idempotent (New#3)", () => {
    it("повторный recordTaskMemory не дублирует узлы", async () => {
      const { recordTaskMemory } = await import("./project-knowledge/memory-extract.ts?t=" + Date.now());
      const { createTask, upsertStep, initBlackboard, writeResult } = await import("./blackboard.ts?t=" + Date.now());
      const { listNodes, projectIdFromPath } = await import("./project-knowledge/memory-store.ts?t=" + Date.now());
      await initBlackboard(dir);
      await createTask({ id: "T-IDM", prompt: "implement auth", workflow: "w", project: dir, root: dir });
      await upsertStep("T-IDM", {
        id: "T-IDM-S02", task_id: "T-IDM", agent: "codex", family: "openai", role: "review",
        status: "failed", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
      }, dir);
      await writeResult("T-IDM", "T-IDM-S02", {
        envelope_id: "T-IDM-S02", agent: "codex", role: "review",
        output: "## Review\nVERDICT: REJECT\n### Blockers\n- missing null check in auth.ts",
        signals: [], success: false, reason: null, duration_ms: 1000, timed_out: false,
      }, dir);

      const c1 = await recordTaskMemory("T-IDM", dir, dir, dbPath);
      const c2 = await recordTaskMemory("T-IDM", dir, dir, dbPath);
      expect(c1).toBe(1);
      expect(c2).toBe(0); // дубль проигнорирован
      const pid = projectIdFromPath(dir);
      const nodes = listNodes(pid, dbPath);
      expect(nodes.length).toBe(1); // не 2
    });
  });

  describe("memory Unicode search (#6)", () => {
    it("русский запрос находит узлы с русским контентом", async () => {
      const { addNode, searchNodes, projectIdFromPath } = await import("./project-knowledge/memory-store.ts?t=" + Date.now());
      const pid = projectIdFromPath(dir);
      addNode({
        project_id: pid, task_id: "T-RU", type: "mistake",
        content: "Забыли проверить null в функции аутентификации пользователя",
      }, dbPath);
      addNode({
        project_id: pid, task_id: "T-EN", type: "decision",
        content: "use sqlite database for storage",
      }, dbPath);
      // Русский запрос.
      const results = searchNodes(pid, "аутентификация пользователя", 5, dbPath);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.task_id).toBe("T-RU");
      // Английский запрос русский узел не находит.
      const enResults = searchNodes(pid, "sqlite storage", 5, dbPath);
      expect(enResults[0]!.task_id).toBe("T-EN");
    });
  });

  describe("projectIdFromPath normalize (Д1)", () => {
    it("trailing slash не меняет hash", async () => {
      const { projectIdFromPath } = await import("./project-knowledge/memory-store.ts?t=" + Date.now());
      const id1 = projectIdFromPath("/Users/x/proj");
      const id2 = projectIdFromPath("/Users/x/proj/");
      const id3 = projectIdFromPath("/Users/x/proj//");
      expect(id1).toBe(id2);
      expect(id1).toBe(id3);
    });

    it("symlink на директорию даёт тот же hash, что и target", async () => {
      const { projectIdFromPath } = await import("./project-knowledge/memory-store.ts?t=" + Date.now());
      const real = mkdtempSync(join(tmpdir(), "orch-real-"));
      const link = join(dir, "symlink-to-real");
      try {
        symlinkSync(real, link);
        const idReal = projectIdFromPath(real);
        const idLink = projectIdFromPath(link);
        // realpath link'а == real, поэтому hash должен совпасть.
        expect(idLink).toBe(idReal);
      } finally {
        rmSync(real, { recursive: true, force: true });
      }
    });
  });
});
