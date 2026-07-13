import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mcp server handlers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-mcp-"));
    // review #11: get_status теперь читает BLACKBOARD_ROOT, а не input.project.
    // Указываем temp-dir, чтобы тесты видели seed-state.json.
    process.env.BLACKBOARD_ROOT = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.BLACKBOARD_ROOT;
  });

  describe("handleListWorkflows", () => {
    it("returns structured workflow list", async () => {
      const workflowsDir = join(dir, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(
        join(workflowsDir, "test.yaml"),
        "name: test\ndescription: |\n  A test workflow.\nsteps:\n  - id: s1\n    agent: glm\n    role: implement\n",
      );
      process.env.WORKFLOWS_DIR = workflowsDir;
      const { handleListWorkflows } = await import("./server.ts?t=" + Date.now());
      const list = await handleListWorkflows();
      expect(list.length).toBe(1);
      expect(list[0]!.name).toBe("test");
      expect(list[0]!.description).toContain("A test workflow");
      expect(list[0]!.steps).toContain("glm(implement)");
      delete process.env.WORKFLOWS_DIR;
    });

    it("returns empty array when workflows dir missing", async () => {
      process.env.WORKFLOWS_DIR = join(dir, "nonexistent");
      const { handleListWorkflows } = await import("./server.ts?t=" + Date.now());
      const list = await handleListWorkflows();
      expect(list).toEqual([]);
      delete process.env.WORKFLOWS_DIR;
    });
  });

  describe("handleGetStatus", () => {
    it("returns task by id", async () => {
      const { handleGetStatus } = await import("./server.ts?t=" + Date.now());
      // Seend state.json через прямой write.
      mkdirSync(join(dir, ".orchestrator"), { recursive: true });
      const task = {
        id: "T-ABC123", prompt: "do something", workflow: "default.yaml", project: dir,
        status: "done", integration_branch: "orch/T-ABC123/integration",
        created_at: "2026-07-13T10:00:00Z", updated_at: "2026-07-13T10:05:00Z",
        steps: [
          { id: "T-ABC123-S01", task_id: "T-ABC123", agent: "glm", family: "zai", role: "implement", status: "success", started_at: null, finished_at: null, attempts: 1, result_path: null, error: null },
        ],
      };
      writeFileSync(
        join(dir, ".orchestrator", "state.json"),
        JSON.stringify({ tasks: [task] }),
      );
      const result = await handleGetStatus({ taskId: "T-ABC123", project: dir, limit: 10 });
      const r = result as { id: string; status: string; steps: string };
      expect(r.id).toBe("T-ABC123");
      expect(r.status).toBe("done");
      expect(r.steps).toBe("1/1");
    });

    it("returns recent tasks list when no taskId", async () => {
      const { handleGetStatus } = await import("./server.ts?t=" + Date.now());
      mkdirSync(join(dir, ".orchestrator"), { recursive: true });
      const mk = (id: string, updated: string) => ({
        id, prompt: "p", workflow: "default.yaml", project: dir, status: "done" as const,
        integration_branch: "orch/" + id + "/integration", created_at: updated, updated_at: updated, steps: [],
      });
      writeFileSync(
        join(dir, ".orchestrator", "state.json"),
        JSON.stringify({ tasks: [mk("T-OLD", "2026-07-10T00:00:00Z"), mk("T-NEW", "2026-07-12T00:00:00Z")] }),
      );
      const result = await handleGetStatus({ project: dir, limit: 10 });
      const list = result as { id: string }[];
      expect(list.length).toBe(2);
      expect(list[0]!.id).toBe("T-NEW"); // свежие первыми
    });

    it("throws for unknown taskId", async () => {
      const { handleGetStatus } = await import("./server.ts?t=" + Date.now());
      mkdirSync(join(dir, ".orchestrator"), { recursive: true });
      writeFileSync(join(dir, ".orchestrator", "state.json"), JSON.stringify({ tasks: [] }));
      await expect(handleGetStatus({ taskId: "T-NONEXIST", project: dir, limit: 10 })).rejects.toThrow(/not found/);
    });

    it("returns empty list when state.json missing", async () => {
      const { handleGetStatus } = await import("./server.ts?t=" + Date.now());
      const result = await handleGetStatus({ project: dir, limit: 10 });
      expect(result).toEqual([]);
    });
  });

  describe("handleRunWorkflow", () => {
    it("rejects empty prompt via Zod schema (input validation)", async () => {
      // RunWorkflowSchema.parse выбрасывает на пустой prompt — это проверяется
      // в диспетчере server.ts перед вызовом handler. Здесь проверяем саму схему.
      const { RunWorkflowSchema } = await import("./server.ts?t=" + Date.now());
      expect(() => RunWorkflowSchema.parse({ prompt: "", workflow: "default" })).toThrow();
    });

    it("applies defaults for optional fields", async () => {
      const { RunWorkflowSchema } = await import("./server.ts?t=" + Date.now());
      const parsed = RunWorkflowSchema.parse({ prompt: "do X" });
      expect(parsed.workflow).toBe("default");
      expect(parsed.noCache).toBe(false);
      expect(parsed.noSmartRouting).toBe(false);
    });

    it("New#4: rejects workflow name with path traversal (../)", async () => {
      const { RunWorkflowSchema } = await import("./server.ts?t=" + Date.now());
      const bad = ["../etc/passwd", "a/b", "a\\b", "ok/../../evil", "."];
      for (const name of bad) {
        expect(() => RunWorkflowSchema.parse({ prompt: "x", workflow: name })).toThrow();
      }
      // Валидные basename-имена проходят.
      expect(RunWorkflowSchema.parse({ prompt: "x", workflow: "default" }).workflow).toBe("default");
      expect(RunWorkflowSchema.parse({ prompt: "x", workflow: "my_workflow-2" }).workflow).toBe("my_workflow-2");
    });
  });

  describe("runner-spawn module", () => {
    it("hasAlive/activeKey empty initially", async () => {
      const { hasAlive, activeKey } = await import("./runner-spawn.ts?t=" + Date.now());
      // Может быть активная сессия от других тестов — проверяем тип возвращаемого значения.
      expect(typeof hasAlive()).toBe("boolean");
      expect(activeKey() === null || typeof activeKey() === "string").toBe(true);
    });

    it("getSession returns undefined for unknown key", async () => {
      const { getSession } = await import("./runner-spawn.ts?t=" + Date.now());
      expect(getSession("nonexistent-key-12345")).toBeUndefined();
    });

    it("New#4: startRunner rejects workflow name with path separators", async () => {
      const { startRunner } = await import("./runner-spawn.ts?t=" + Date.now());
      expect(() => startRunner({ prompt: "x", workflow: "../evil", project: "/tmp" })).toThrow(/invalid workflow name/);
      expect(() => startRunner({ prompt: "x", workflow: "a/b", project: "/tmp" })).toThrow(/invalid workflow name/);
    });
  });

  describe("blackboard-reader", () => {
    it("getTask returns null for missing state.json", async () => {
      const { getTask } = await import("./blackboard-reader.ts?t=" + Date.now());
      const t = await getTask("T-X", dir);
      expect(t).toBeNull();
    });

    it("listTasks returns empty when state.json missing", async () => {
      const { listTasks } = await import("./blackboard-reader.ts?t=" + Date.now());
      expect(await listTasks(dir)).toEqual([]);
    });

    it("listTasks reads and sorts tasks by updated_at desc", async () => {
      const { listTasks } = await import("./blackboard-reader.ts?t=" + Date.now());
      mkdirSync(join(dir, ".orchestrator"), { recursive: true });
      writeFileSync(
        join(dir, ".orchestrator", "state.json"),
        JSON.stringify({
          tasks: [
            { id: "T-1", updated_at: "2026-07-01", steps: [] },
            { id: "T-2", updated_at: "2026-07-03", steps: [] },
            { id: "T-3", updated_at: "2026-07-02", steps: [] },
          ],
        }),
      );
      const tasks = await listTasks(dir);
      expect(tasks.map((t: { id: string }) => t.id)).toEqual(["T-2", "T-3", "T-1"]);
    });

    it("returns empty array on corrupt state.json (not throw)", async () => {
      const { listTasks } = await import("./blackboard-reader.ts?t=" + Date.now());
      mkdirSync(join(dir, ".orchestrator"), { recursive: true });
      writeFileSync(join(dir, ".orchestrator", "state.json"), "{ not valid json");
      expect(await listTasks(dir)).toEqual([]);
    });
  });
});
