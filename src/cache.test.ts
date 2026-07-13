import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

describe("cache", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Мини-хелпер: создать git-репо с одним коммитом, вернуть путь. */
  function freshRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "orch-cache-repo-"));
    const sh = (args: string[], cwd = root) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    sh(["init", "-q", "-b", "main"]);
    sh(["config", "user.email", "t@t.t"]);
    sh(["config", "user.name", "t"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
    return root;
  }

  it("cacheKey is deterministic for identical inputs", async () => {
    const { cacheKey } = await import("./cache.ts?t=" + Date.now());
    const { loadModelsConfig, resetRegistry, getModel } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(dir);
    const { makeEnvelope } = await import("./envelope.ts?t=" + Date.now());
    const env = makeEnvelope({
      id: "t1", agent: "claude", role: "plan", prompt: "do X",
      target_paths: [], context: null, budget: { wall_time_sec: 100, max_steps: 2 }, effort: "medium",
    });
    const model = getModel("claude")!;
    const k1 = cacheKey(env, model);
    const k2 = cacheKey(env, model);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("cacheKey changes when prompt changes", async () => {
    const { cacheKey } = await import("./cache.ts?t=" + Date.now());
    const { loadModelsConfig, resetRegistry, getModel } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(dir);
    const { makeEnvelope } = await import("./envelope.ts?t=" + Date.now());
    const model = getModel("claude")!;
    const base = {
      id: "t1", agent: "claude", role: "plan", target_paths: [], context: null,
      budget: { wall_time_sec: 100, max_steps: 2 }, effort: "medium",
    };
    const k1 = cacheKey(makeEnvelope({ ...base, prompt: "do X" }), model);
    const k2 = cacheKey(makeEnvelope({ ...base, prompt: "do Y" }), model);
    expect(k1).not.toBe(k2);
  });

  it("cacheKey changes when agent/model changes", async () => {
    const { cacheKey } = await import("./cache.ts?t=" + Date.now());
    const { loadModelsConfig, resetRegistry, getModel } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(dir);
    const { makeEnvelope } = await import("./envelope.ts?t=" + Date.now());
    const prompt = "same";
    const e1 = makeEnvelope({ id: "t1", agent: "claude", role: "plan", prompt, target_paths: [], context: null, budget: { wall_time_sec: 100, max_steps: 2 }, effort: "medium" });
    const e2 = makeEnvelope({ id: "t1", agent: "codex", role: "plan", prompt, target_paths: [], context: null, budget: { wall_time_sec: 100, max_steps: 2 }, effort: "medium" });
    const k1 = cacheKey(e1, getModel("claude")!);
    const k2 = cacheKey(e2, getModel("codex")!);
    expect(k1).not.toBe(k2);
  });

  it("cacheKey changes when role changes", async () => {
    const { cacheKey } = await import("./cache.ts?t=" + Date.now());
    const { loadModelsConfig, resetRegistry, getModel } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(dir);
    const { makeEnvelope } = await import("./envelope.ts?t=" + Date.now());
    const model = getModel("claude")!;
    const base = {
      id: "t1", agent: "claude", prompt: "x", target_paths: [], context: null,
      budget: { wall_time_sec: 100, max_steps: 2 }, effort: "medium",
    };
    const k1 = cacheKey(makeEnvelope({ ...base, role: "plan" }), model);
    const k2 = cacheKey(makeEnvelope({ ...base, role: "review" }), model);
    expect(k1).not.toBe(k2);
  });

  it("writeCache → readCache round-trips", async () => {
    const { writeCache, readCache, cachePath } = await import("./cache.ts?t=" + Date.now());
    const entry = {
      hash: "abc123",
      agent: "claude", role: "plan",
      result: {
        exit_ok: true, exit_code: 0, output: "hello", timed_out: false,
        has_output: true, has_changes: null,
        signals: [{ name: "exit_0", ok: true, detail: "exit=0" }],
        success: true, reason: null, stderr: "", duration_ms: 5000,
      },
      patch: null,
      created_at: new Date().toISOString(),
      model_tag: "",
    };
    await writeCache(entry, dir);
    expect(existsSync(cachePath("abc123", dir))).toBe(true);
    const back = await readCache("abc123", { root: dir });
    expect(back).not.toBeNull();
    expect(back!.result.output).toBe("hello");
    expect(back!.agent).toBe("claude");
  });

  it("readCache returns null for missing entry", async () => {
    const { readCache } = await import("./cache.ts?t=" + Date.now());
    const back = await readCache("nonexistent-hash", { root: dir });
    expect(back).toBeNull();
  });

  it("readCache returns null when TTL expired", async () => {
    const { writeCache, readCache } = await import("./cache.ts?t=" + Date.now());
    // Старая запись (2 часа назад), TTL = 1 час → устарела.
    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await writeCache({
      hash: "expired", agent: "claude", role: "plan",
      result: { exit_ok: true, exit_code: 0, output: "x", timed_out: false, has_output: true, has_changes: null, signals: [], success: true, reason: null, stderr: "", duration_ms: 1 },
      patch: null, created_at: old, model_tag: "",
    }, dir);
    const back = await readCache("expired", { ttlSec: 3600, root: dir });
    expect(back).toBeNull();
  });

  it("readCache respects TTL = not expired", async () => {
    const { writeCache, readCache } = await import("./cache.ts?t=" + Date.now());
    // Свежая запись, TTL = 1 час → валидна.
    await writeCache({
      hash: "fresh", agent: "claude", role: "plan",
      result: { exit_ok: true, exit_code: 0, output: "y", timed_out: false, has_output: true, has_changes: null, signals: [], success: true, reason: null, stderr: "", duration_ms: 1 },
      patch: null, created_at: new Date().toISOString(), model_tag: "",
    }, dir);
    const back = await readCache("fresh", { ttlSec: 3600, root: dir });
    expect(back).not.toBeNull();
  });

  it("readCache returns null for corrupt JSON (cache miss, no throw)", async () => {
    const { readCache, cachePath } = await import("./cache.ts?t=" + Date.now());
    // Запишем мусор напрямую в файл кэша.
    mkdirSync(join(dir, ".orchestrator", "cache"), { recursive: true });
    writeFileSync(cachePath("corrupt", dir), "{ this is not json");
    const back = await readCache("corrupt", { root: dir });
    expect(back).toBeNull();
  });

  it("applyPatch applies a valid patch to a git worktree", async () => {
    const { applyPatch } = await import("./cache.ts?t=" + Date.now());
    const repo = freshRepo();
    try {
      // Снanim patch: изменить base.txt на "patched\n".
      const patch = `diff --git a/base.txt b/base.txt\nindex 1c2b8a3..e69de29 100644\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-base\n+patched\n`;
      const ok = await applyPatch(patch, repo);
      expect(ok).toBe(true);
      expect(readFileSync(join(repo, "base.txt"), "utf8")).toContain("patched");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("applyPatch returns true for empty patch (read-only role)", async () => {
    const { applyPatch } = await import("./cache.ts?t=" + Date.now());
    const ok = await applyPatch("", dir);
    expect(ok).toBe(true);
  });

  it("applyPatch returns false for a conflicting/invalid patch", async () => {
    const { applyPatch } = await import("./cache.ts?t=" + Date.now());
    const repo = freshRepo();
    try {
      // Патч на несуществующий контекст (контекстная строка не совпадёт) → конфликт.
      const patch = `diff --git a/base.txt b/base.txt\nindex 1c2b8a3..e69de29 100644\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-NOT_THE_ACTUAL_CONTENT\n+patched\n`;
      const ok = await applyPatch(patch, repo);
      expect(ok).toBe(false);
      // Файл не изменился при неудачном apply.
      expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("base\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("concurrent writeCache with distinct keys all readable", async () => {
    const { writeCache, readCache } = await import("./cache.ts?t=" + Date.now());
    const N = 50;
    const entries = Array.from({ length: N }, (_, i) => ({
      hash: `k${i}`,
      agent: "claude", role: "plan",
      result: { exit_ok: true, exit_code: 0, output: `out-${i}`, timed_out: false, has_output: true, has_changes: null, signals: [], success: true, reason: null, stderr: "", duration_ms: i },
      patch: null, created_at: new Date().toISOString(), model_tag: "",
    }));
    await Promise.all(entries.map((e) => writeCache(e, dir)));
    // Все N читаются.
    for (let i = 0; i < N; i++) {
      const back = await readCache(`k${i}`, { root: dir });
      expect(back).not.toBeNull();
      expect(back!.result.output).toBe(`out-${i}`);
    }
  });

  // review #29 (review-2026-07-13): ранее captureRepoFingerprint обрезал
  // содержимое untracked-файлов до 4096 символов — две версии файла,
  // различающиеся только после этого лимита, давали одинаковый fingerprint
  // (stale cache). Теперь хешируется полное содержимое.
  it("captureRepoFingerprint differs for untracked content past the old 4096 limit", async () => {
    const { captureRepoFingerprint } = await import("./cache.ts?t=" + Date.now());
    const repo = freshRepo();
    try {
      // Общий префикс длиннее прежнего лимита в 4096, различается только хвост.
      const prefix = "x".repeat(5000);
      writeFileSync(join(repo, "big.txt"), prefix + "TAIL_A\n");
      const fp1 = await captureRepoFingerprint(repo);
      writeFileSync(join(repo, "big.txt"), prefix + "TAIL_B\n");
      const fp2 = await captureRepoFingerprint(repo);
      expect(fp1).not.toBeNull();
      expect(fp2).not.toBeNull();
      expect(fp1!.dirtyFingerprint).not.toBe(fp2!.dirtyFingerprint);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
