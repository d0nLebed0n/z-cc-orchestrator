import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("envelope (registry-backed)", () => {
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-env-"));
    const { loadModelsConfig, resetRegistry } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(dir);
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("makeEnvelope infers family from registry", async () => {
    const { makeEnvelope } = await import("./envelope.ts?t=" + Date.now());
    const e = makeEnvelope({
      id: "t1",
      agent: "claude",
      role: "plan",
      prompt: "test",
      target_paths: [],
      context: null,
      budget: { wall_time_sec: 100, max_steps: 2 },
      effort: "medium",
    });
    expect(e.family).toBe("anthropic");
  });

  it("makeEnvelope rejects unknown agent", async () => {
    const { makeEnvelope } = await import("./envelope.ts?t=" + Date.now());
    expect(() =>
      makeEnvelope({
        id: "t1",
        agent: "ghost",
        role: "plan",
        prompt: "test",
        target_paths: [],
        context: null,
        budget: { wall_time_sec: 100, max_steps: 2 },
        effort: "medium",
      }),
    ).toThrow();
  });

  it("validateEnvelope rejects mismatched family", async () => {
    const { makeEnvelope, validateEnvelope } = await import("./envelope.ts?t=" + Date.now());
    const e = makeEnvelope({
      id: "t1",
      agent: "claude",
      role: "plan",
      prompt: "test",
      target_paths: [],
      context: null,
      budget: { wall_time_sec: 100, max_steps: 2 },
      effort: "medium",
      family: "anthropic",
    });
    // Tamper: force a wrong family.
    const bad = { ...e, family: "openai" as const };
    expect(() => validateEnvelope(bad)).toThrow();
  });
});
