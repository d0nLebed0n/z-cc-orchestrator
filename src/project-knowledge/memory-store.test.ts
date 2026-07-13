import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory-store (T4)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-mem-"));
    dbPath = join(dir, "knowledge.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("projectIdFromPath is stable SHA-256 and differs per path", async () => {
    const { projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const id1 = projectIdFromPath("/Users/x/projects/foo");
    const id2 = projectIdFromPath("/Users/x/projects/foo");
    const id3 = projectIdFromPath("/Users/x/projects/bar");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{64}$/); // full SHA-256 hex
  });

  it("initMemoryDb is idempotent (safe to call twice)", async () => {
    const { initMemoryDb } = await import("./memory-store.ts?t=" + Date.now());
    const db1 = initMemoryDb(dbPath);
    db1.close();
    const db2 = initMemoryDb(dbPath); // не бросает
    db2.close();
  });

  it("addNode inserts and returns id + inserted flag", async () => {
    const { addNode, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const pid = projectIdFromPath("/proj/x");
    const res = addNode({ project_id: pid, task_id: "T-A", type: "mistake", content: "forgot null check" }, dbPath);
    expect(typeof res.id).toBe("number");
    expect(res.id).toBeGreaterThan(0);
    expect(res.inserted).toBe(true);
    // review New#3 (T1-T5): дубль игнорируется.
    const dup = addNode({ project_id: pid, task_id: "T-A", type: "mistake", content: "forgot null check" }, dbPath);
    expect(dup.inserted).toBe(false);
    expect(dup.id).toBe(res.id);
  });

  it("listNodes returns nodes for project, newest first", async () => {
    const { addNode, listNodes, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const pid = projectIdFromPath("/proj/list");
    addNode({ project_id: pid, task_id: "T-1", type: "decision", content: "use sqlite" }, dbPath);
    addNode({ project_id: pid, task_id: "T-2", type: "mistake", content: "race condition" }, dbPath);
    const nodes = listNodes(pid, dbPath);
    expect(nodes.length).toBe(2);
    expect(nodes[0]!.task_id).toBe("T-2"); // свежие первыми
  });

  it("listNodes isolates by project_id", async () => {
    const { addNode, listNodes, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const pid1 = projectIdFromPath("/proj/a");
    const pid2 = projectIdFromPath("/proj/b");
    addNode({ project_id: pid1, task_id: "T-1", type: "decision", content: "proj a fact" }, dbPath);
    addNode({ project_id: pid2, task_id: "T-2", type: "decision", content: "proj b fact" }, dbPath);
    expect(listNodes(pid1, dbPath).length).toBe(1);
    expect(listNodes(pid2, dbPath).length).toBe(1);
  });

  it("searchNodes returns BM25-ranked results", async () => {
    const { addNode, searchNodes, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const pid = projectIdFromPath("/proj/search");
    addNode({ project_id: pid, task_id: "T-1", type: "mistake", content: "null pointer dereference in auth module" }, dbPath);
    addNode({ project_id: pid, task_id: "T-2", type: "decision", content: "use REST API for auth service" }, dbPath);
    addNode({ project_id: pid, task_id: "T-3", type: "mistake", content: "off-by-one in sort algorithm" }, dbPath);
    // Поиск "auth" — должен найти T-1 и T-2, не T-3.
    const results = searchNodes(pid, "auth bug in login", 5, dbPath);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // T-1 и T-2 в результатах, T-3 нет.
    const taskIds = results.map((r: { task_id: string }) => r.task_id);
    expect(taskIds).toContain("T-1");
    expect(taskIds).toContain("T-2");
    expect(taskIds).not.toContain("T-3");
  });

  it("searchNodes respects limit", async () => {
    const { addNode, searchNodes, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const pid = projectIdFromPath("/proj/limit");
    for (let i = 0; i < 10; i++) {
      addNode({ project_id: pid, task_id: `T-${i}`, type: "decision", content: `auth pattern variant ${i}` }, dbPath);
    }
    const results = searchNodes(pid, "auth", 3, dbPath);
    expect(results.length).toBe(3);
  });

  it("searchNodes returns empty for no matches", async () => {
    const { addNode, searchNodes, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const pid = projectIdFromPath("/proj/empty");
    addNode({ project_id: pid, task_id: "T-1", type: "decision", content: "database migration strategy" }, dbPath);
    const results = searchNodes(pid, "completely-unrelated-xyzzy", 5, dbPath);
    expect(results).toEqual([]);
  });

  it("searchNodes returns empty for empty/sanitized query", async () => {
    const { addNode, searchNodes, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const pid = projectIdFromPath("/proj/q");
    addNode({ project_id: pid, task_id: "T-1", type: "decision", content: "something" }, dbPath);
    expect(searchNodes(pid, "", 5, dbPath)).toEqual([]);
    expect(searchNodes(pid, "ab", 5, dbPath)).toEqual([]); // слишком короткое слово (<3)
  });

  it("searchNodes does not throw on FTS-special characters", async () => {
    const { addNode, searchNodes, projectIdFromPath } = await import("./memory-store.ts?t=" + Date.now());
    const pid = projectIdFromPath("/proj/spec");
    addNode({ project_id: pid, task_id: "T-1", type: "decision", content: "test" }, dbPath);
    // Сырой FTS синтаксис в запросе не должен бросать.
    expect(() => searchNodes(pid, '"* OR AND --', 5, dbPath)).not.toThrow();
  });
});
