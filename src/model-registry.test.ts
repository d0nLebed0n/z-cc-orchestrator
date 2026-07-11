import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "./model-config-dto.ts";

describe("model-registry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds default config when models.yaml absent", async () => {
    const { loadModelsConfig } = await import("./model-registry.ts?t=" + Date.now());
    const cfg = loadModelsConfig(dir);
    expect(cfg.models.map((m: ModelInfo) => m.id)).toEqual(
      expect.arrayContaining(["claude", "codex", "glm", "ollama"]),
    );
    expect(cfg.complexity_threshold).toBe(65);
  });

  it("reads existing models.yaml", async () => {
    writeFileSync(
      join(dir, "models.yaml"),
      `models:\n  - id: custom\n    label: Custom\n    kind: api\n    family: zai\nroles:\n  plan: custom\n  implement: custom\n  review: custom\n  refine: custom\n  fix: custom\n  final: custom\ncomplexity_threshold: 40\n`,
    );
    const { loadModelsConfig } = await import("./model-registry.ts?t=" + Date.now());
    const cfg = loadModelsConfig(dir);
    expect(cfg.models[0]!.id).toBe("custom");
    expect(cfg.complexity_threshold).toBe(40);
  });

  it("getSecret reads .secrets file", async () => {
    writeFileSync(join(dir, ".secrets"), "custom=sk-test-123\n");
    const { loadModelsConfig, getSecret } = await import("./model-registry.ts?t=" + Date.now());
    loadModelsConfig(dir);
    expect(getSecret("custom")).toBe("sk-test-123");
  });
});
