import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("run-lock (review #25)", () => {
  let dir: string;

  beforeEach(() => {
    // Чистый root: .orchestrator/ НЕ существует — раньше acquire падал с ENOENT.
    dir = mkdtempSync(join(tmpdir(), "orch-runlock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquire succeeds on a clean root (no .orchestrator/ dir) and creates lock", async () => {
    const { acquireRunLock } = await import("./run-lock.ts?t=" + Date.now());
    const lock = await acquireRunLock(dir);
    const lockPath = join(dir, ".orchestrator", ".run-lock");
    expect(existsSync(lockPath)).toBe(true);
    // Формат: pid:token
    const raw = readFileSync(lockPath, "utf8").trim();
    expect(raw).toMatch(/^.+:.+$/);
    lock.release();
  });

  it("second acquire on same root throws (held by live process)", async () => {
    const { acquireRunLock } = await import("./run-lock.ts?t=" + Date.now());
    const lock = await acquireRunLock(dir);
    try {
      await expect(acquireRunLock(dir)).rejects.toThrow(/another orchestrator run is active/);
    } finally {
      lock.release();
    }
  });

  it("release frees the lock (next acquire succeeds)", async () => {
    const { acquireRunLock } = await import("./run-lock.ts?t=" + Date.now());
    const lock = await acquireRunLock(dir);
    lock.release();
    // Дать async-release завершиться.
    await new Promise((r) => setTimeout(r, 20));
    const lockPath = join(dir, ".orchestrator", ".run-lock");
    expect(existsSync(lockPath)).toBe(false);
    // Повторный захват после release — ок.
    const lock2 = await acquireRunLock(dir);
    lock2.release();
  });

  it("acquire recovers from a stale lock (dead PID)", async () => {
    const { acquireRunLock } = await import("./run-lock.ts?t=" + Date.now());
    // Создаём stale lock: PID, которого точно нет (максимальный +1).
    const lockPath = join(dir, ".orchestrator", ".run-lock");
    // mkdirSync чтобы положить файл напрямую.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".orchestrator"), { recursive: true });
    const bogusPid = 2_000_000;
    writeFileSync(lockPath, `${bogusPid}:deadbeef`);
    // stale → должен удалиться и захват пройти.
    const lock = await acquireRunLock(dir);
    // После захвата в файле — наш PID:token, не bogus.
    const raw = readFileSync(lockPath, "utf8").trim();
    expect(raw).not.toContain(String(bogusPid));
    lock.release();
  });
});
