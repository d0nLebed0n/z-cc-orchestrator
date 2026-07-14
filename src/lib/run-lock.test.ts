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
    await lock.release();
  });

  it("second acquire on same root throws (held by live process)", async () => {
    const { acquireRunLock } = await import("./run-lock.ts?t=" + Date.now());
    const lock = await acquireRunLock(dir);
    try {
      await expect(acquireRunLock(dir)).rejects.toThrow(/another orchestrator run is active/);
    } finally {
      await lock.release();
    }
  });

  it("release frees the lock (next acquire succeeds)", async () => {
    const { acquireRunLock } = await import("./run-lock.ts?t=" + Date.now());
    const lock = await acquireRunLock(dir);
    // review #47: release теперь awaited — sleep не нужен.
    await lock.release();
    const lockPath = join(dir, ".orchestrator", ".run-lock");
    expect(existsSync(lockPath)).toBe(false);
    // Повторный захват сразу после awaited release — ок.
    const lock2 = await acquireRunLock(dir);
    await lock2.release();
  });

  // review #47 (review-2026-07-13): немедленный acquire после awaited release.
  // Раньше release был fire-and-forget IIFE, и acquire ловил собственный lock.
  it("immediate acquire after awaited release succeeds (no stale self-lock)", async () => {
    const { acquireRunLock } = await import("./run-lock.ts?t=" + Date.now());
    const lock1 = await acquireRunLock(dir);
    await lock1.release();
    // Без sleep, без задержки — lock-файл уже удалён.
    const lock2 = await acquireRunLock(dir);
    expect(lock2.ownerToken).not.toBe(lock1.ownerToken);
    await lock2.release();
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
    await lock.release();
  });
});
