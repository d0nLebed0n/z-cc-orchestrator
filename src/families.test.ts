import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("families (registry-backed)", () => {
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-fam-"));
    const { loadModelsConfig, resetRegistry } = await import("./model-registry.ts?t=" + Date.now());
    resetRegistry();
    loadModelsConfig(dir);
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("getAgentFamily reads from registry", async () => {
    const { getAgentFamily } = await import("./families.ts?t=" + Date.now());
    expect(getAgentFamily("claude")).toBe("anthropic");
    expect(getAgentFamily("ollama")).toBe("local");
    expect(getAgentFamily("nonexistent")).toBeUndefined();
  });

  it("pickReviewer returns a model from different family", async () => {
    const { pickReviewer } = await import("./families.ts?t=" + Date.now());
    const reviewer = pickReviewer("anthropic");
    const { getAgentFamily } = await import("./families.ts?t=" + Date.now());
    expect(getAgentFamily(reviewer)).not.toBe("anthropic");
  });

  it("pickReviewer honors prefer when different family", async () => {
    const { pickReviewer } = await import("./families.ts?t=" + Date.now());
    // codex (openai) is a valid reviewer for an anthropic author.
    expect(pickReviewer("anthropic", "codex")).toBe("codex");
  });

  it("pickReviewer throws on same-family prefer", async () => {
    const { pickReviewer, CrossFamilyViolation } = await import("./families.ts?t=" + Date.now());
    expect(() => pickReviewer("anthropic", "claude")).toThrow(CrossFamilyViolation);
  });
});
