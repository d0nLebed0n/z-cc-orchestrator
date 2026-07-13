import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory-extract (T4)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-extract-"));
    dbPath = join(dir, "knowledge.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("extractFromReview", () => {
    it("REJECT → Mistake node with blockers text", async () => {
      const { extractFromReview } = await import("./memory-extract.ts?t=" + Date.now());
      const output = "## Review\nVERDICT: REJECT\n\n### Blockers\n- [auth.ts:10] null dereference\n- [api.ts:5] missing error handling\n### Suggestions\n- add tests";
      const nodes = extractFromReview(output, "REJECT", { taskId: "T-1", prompt: "implement auth login" });
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.type).toBe("mistake");
      expect(nodes[0]!.content).toContain("null dereference");
      expect(nodes[0]!.content).toContain("missing error handling");
      expect(nodes[0]!.task_id).toBe("T-1");
    });

    it("REQUEST_CHANGES → Mistake node", async () => {
      const { extractFromReview } = await import("./memory-extract.ts?t=" + Date.now());
      const output = "## Review\nVERDICT: REQUEST_CHANGES\n\n### Blockers\n- refactor needed in module X";
      const nodes = extractFromReview(output, "REQUEST_CHANGES", { taskId: "T-2", prompt: "refactor module X" });
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.type).toBe("mistake");
      expect(nodes[0]!.content).toContain("refactor needed");
    });

    it("APPROVE → Decision node", async () => {
      const { extractFromReview } = await import("./memory-extract.ts?t=" + Date.now());
      const output = "## Review\nVERDICT: APPROVE\n\nGood work.";
      const nodes = extractFromReview(output, "APPROVE", { taskId: "T-3", prompt: "add user service" });
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.type).toBe("decision");
      expect(nodes[0]!.content).toContain("add user service");
    });

    it("null verdict → no nodes", async () => {
      const { extractFromReview } = await import("./memory-extract.ts?t=" + Date.now());
      const nodes = extractFromReview("no verdict here", null, { taskId: "T-4", prompt: "x" });
      expect(nodes).toEqual([]);
    });
  });

  describe("extractFromFinal", () => {
    it("ACCEPT → Decision node", async () => {
      const { extractFromFinal } = await import("./memory-extract.ts?t=" + Date.now());
      const output = "## Final\nVERDICT: ACCEPT\nTests: 5/0\nNotes: none";
      const nodes = extractFromFinal(output, "ACCEPT", { taskId: "T-5", prompt: "feature X" });
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.type).toBe("decision");
      expect(nodes[0]!.content).toContain("feature X");
    });

    it("non-empty Notes → Pattern node", async () => {
      const { extractFromFinal } = await import("./memory-extract.ts?t=" + Date.now());
      const output = "## Final\nVERDICT: ACCEPT\nNotes: edge case when user is admin needs special handling";
      const nodes = extractFromFinal(output, "ACCEPT", { taskId: "T-6", prompt: "permission check" });
      // Decision + Pattern.
      expect(nodes.length).toBe(2);
      const pattern = nodes.find((n: { type: string }) => n.type === "pattern");
      expect(pattern).toBeDefined();
      expect(pattern!.content).toContain("admin needs special handling");
    });

    it("Notes: none → no Pattern node", async () => {
      const { extractFromFinal } = await import("./memory-extract.ts?t=" + Date.now());
      const output = "## Final\nVERDICT: ACCEPT\nNotes: none";
      const nodes = extractFromFinal(output, "ACCEPT", { taskId: "T-7", prompt: "x" });
      expect(nodes.length).toBe(1); // только Decision
      expect(nodes[0]!.type).toBe("decision");
    });
  });

  describe("recordTaskMemory", () => {
    it("reads review/final steps from blackboard and records nodes", async () => {
      const { recordTaskMemory } = await import("./memory-extract.ts?t=" + Date.now());
      const { listNodes, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
      const { createTask, upsertStep, initBlackboard, writeResult } = await import("../blackboard.ts?t=" + Date.now());
      await initBlackboard(dir);
      await createTask({ id: "T-RM", prompt: "implement auth module", workflow: "w", project: dir, root: dir });
      // review REJECT → Mistake.
      await upsertStep("T-RM", {
        id: "T-RM-S02", task_id: "T-RM", agent: "codex", family: "openai", role: "review",
        status: "failed", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
      }, dir);
      await writeResult("T-RM", "T-RM-S02", {
        envelope_id: "T-RM-S02", agent: "codex", role: "review",
        output: "## Review\nVERDICT: REJECT\n### Blockers\n- missing null check in auth.ts",
        signals: [], success: false, reason: null, duration_ms: 1000, timed_out: false,
      }, dir);

      const count = await recordTaskMemory("T-RM", dir, dir, dbPath);
      expect(count).toBe(1);
      const pid = projectIdFromPath(dir);
      const nodes = listNodes(pid, dbPath);
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.type).toBe("mistake");
      expect(nodes[0]!.content).toContain("null check");
    });

    it("returns 0 for unknown task", async () => {
      const { recordTaskMemory } = await import("./memory-extract.ts?t=" + Date.now());
      const count = await recordTaskMemory("T-NONEXIST", dir, dir, dbPath);
      expect(count).toBe(0);
    });

    it("skips non-review/final steps", async () => {
      const { recordTaskMemory } = await import("./memory-extract.ts?t=" + Date.now());
      const { createTask, upsertStep, initBlackboard, writeResult } = await import("../blackboard.ts?t=" + Date.now());
      await initBlackboard(dir);
      await createTask({ id: "T-SKIP", prompt: "p", workflow: "w", project: dir, root: dir });
      // implement-шаг — не источник узлов.
      await upsertStep("T-SKIP", {
        id: "T-SKIP-S01", task_id: "T-SKIP", agent: "glm", family: "zai", role: "implement",
        status: "success", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null,
      }, dir);
      await writeResult("T-SKIP", "T-SKIP-S01", {
        envelope_id: "T-SKIP-S01", agent: "glm", role: "implement",
        output: "lots of implementation detail text",
        signals: [], success: true, reason: null, duration_ms: 1000, timed_out: false,
      }, dir);
      const count = await recordTaskMemory("T-SKIP", dir, dir, dbPath);
      expect(count).toBe(0);
    });
  });
});
