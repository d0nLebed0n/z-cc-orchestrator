/**
 * Интеграционные тесты cache, выявленные CODE_REVIEW_2026-07-13_T1-T5:
 *   #1 — cache key меняется при смене repo state (editing-роли)
 *   #2 — patch включает untracked-файлы
 *   New#2 — applyPatch проверяет baseSha перед replay
 *
 * Эти сценарии требуют реального git-репозитория (temp), поэтому вынесены
 * отдельно от unit-тестов cache.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

describe("cache integration (T1-T5 review)", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-cache-int-"));
    repo = freshRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function freshRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "orch-cache-repo-"));
    const sh = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    sh(["init", "-q", "-b", "main"]);
    sh(["config", "user.email", "t@t.t"]);
    sh(["config", "user.name", "t"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
    return root;
  }

  it("#1 cacheKey для editing-роли меняется при смене repo state", async () => {
    const { cacheKey, captureRepoFingerprint } = await import("./cache.ts?t=" + Date.now());
    const { loadModelsConfig, resetRegistry, getModel } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(join(dir, ".orchestrator"));
    const { makeEnvelope } = await import("./envelope.ts?t=" + Date.now());
    const model = getModel("claude")!;

    const base = {
      id: "t1", agent: "claude", role: "implement", target_paths: [], context: null,
      budget: { wall_time_sec: 100, max_steps: 2 }, effort: "medium",
    };
    const env = makeEnvelope({ ...base, prompt: "implement feature X" });

    const fp1 = await captureRepoFingerprint(repo);
    const key1 = cacheKey(env, model, fp1);

    // Меняем код: новый коммит.
    writeFileSync(join(repo, "new.txt"), "new\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "change"], { cwd: repo });

    const fp2 = await captureRepoFingerprint(repo);
    const key2 = cacheKey(env, model, fp2);

    expect(fp1!.baseSha).not.toBe(fp2!.baseSha);
    expect(key1).not.toBe(key2);
  });

  it("#5 cacheKey для read-only роли меняется при смене repo state (review/plan читают код)", async () => {
    // review #5 (review-2026-07-13): ранее тест закреплял, что review-ключ НЕ
    // меняется — это неверное поведение. plan/review/final запускаются в worktree
    // и могут читать файлы → repo state влияет на ответ.
    const { cacheKey, captureRepoFingerprint } = await import("./cache.ts?t=" + Date.now());
    const { loadModelsConfig, resetRegistry, getModel } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(join(dir, ".orchestrator"));
    const { makeEnvelope } = await import("./envelope.ts?t=" + Date.now());
    const model = getModel("claude")!;

    const env = makeEnvelope({
      id: "t1", agent: "claude", role: "review", prompt: "review feature X",
      target_paths: [], context: null, budget: { wall_time_sec: 100, max_steps: 2 }, effort: "medium",
    });

    const fp1 = await captureRepoFingerprint(repo);
    const key1 = cacheKey(env, model, fp1);

    writeFileSync(join(repo, "new.txt"), "new\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "change"], { cwd: repo });

    const fp2 = await captureRepoFingerprint(repo);
    const key2 = cacheKey(env, model, fp2);

    // read-only роль тоже зависит от repo state теперь.
    expect(fp1!.baseSha).not.toBe(fp2!.baseSha);
    expect(key1).not.toBe(key2);
  });

  it("#5 dirtyFingerprint меняется при разных правках того же файла (content hash)", async () => {
    const { captureRepoFingerprint } = await import("./cache.ts?t=" + Date.now());
    // Правка 1.
    writeFileSync(join(repo, "base.txt"), "base\nchange-A\n");
    const fp1 = await captureRepoFingerprint(repo);
    // Откат.
    execFileSync("git", ["checkout", "--", "base.txt"], { cwd: repo });
    // Правка 2 — тот же файл, porcelain status совпадает (" M base.txt"),
    // но содержимое diff'а отличается.
    writeFileSync(join(repo, "base.txt"), "base\nchange-B-different\n");
    const fp2 = await captureRepoFingerprint(repo);
    expect(fp1!.dirtyFingerprint).not.toBe(fp2!.dirtyFingerprint);
  });

  it("#2 patch с untracked-файлом: applyPatch восстанавливает новый файл", async () => {
    // Симулируем cache miss → capture: agent создал new.txt + изменил base.txt.
    const { applyPatch } = await import("./cache.ts?t=" + Date.now());

    // Worktree с base-состоянием.
    const wt = freshRepo();
    try {
      // Снимаем patch через runner-логику (git add -A + diff --cached).
      writeFileSync(join(wt, "new.txt"), "new content\n");
      writeFileSync(join(wt, "base.txt"), "base\nchanged\n");
      execFileSync("git", ["add", "-A"], { cwd: wt });
      const patch = execFileSync("git", ["diff", "--cached"], { cwd: wt, encoding: "utf8" });
      execFileSync("git", ["reset", "--mixed", "HEAD"], { cwd: wt, stdio: ["ignore", "pipe", "ignore"] });
      // Удаляем правки (имитируем свежий worktree).
      rmSync(join(wt, "new.txt"));
      writeFileSync(join(wt, "base.txt"), "base\n");
      execFileSync("git", ["checkout", "--", "."], { cwd: wt });

      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
      const ok = await applyPatch(patch, wt, baseSha);
      expect(ok).toBe(true);
      // untracked-файл восстановлен.
      expect(readFileSync(join(wt, "new.txt"), "utf8")).toBe("new content\n");
      expect(readFileSync(join(wt, "base.txt"), "utf8")).toBe("base\nchanged\n");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("New#2 applyPatch возвращает false при смещённом baseSha", async () => {
    const { applyPatch } = await import("./cache.ts?t=" + Date.now());
    const wt = freshRepo();
    try {
      // Патч от старого baseSha.
      const patch = `diff --git a/file.txt b/file.txt\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+x\n`;
      const fakeSha = "0".repeat(40); // не совпадает с реальным HEAD
      const ok = await applyPatch(patch, wt, fakeSha);
      expect(ok).toBe(false);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("captureRepoFingerprint возвращает null для не-git директории", async () => {
    const { captureRepoFingerprint } = await import("./cache.ts?t=" + Date.now());
    const nonGit = mkdtempSync(join(tmpdir(), "orch-nongit-"));
    try {
      const fp = await captureRepoFingerprint(nonGit);
      expect(fp).toBeNull();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
