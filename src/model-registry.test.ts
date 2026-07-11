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

  it("migrates GLM_API_KEY from env into .secrets on fresh seed", async () => {
    const prevKey = process.env.GLM_API_KEY;
    const prevUrl = process.env.GLM_BASE_URL;
    process.env.GLM_API_KEY = "sk-glm-from-env";
    process.env.GLM_BASE_URL = "https://custom.glm.base/api/anthropic";
    try {
      const { loadModelsConfig, getSecret } = await import("./model-registry.ts?t=" + Date.now());
      const cfg = loadModelsConfig(dir);
      // Key migrated into secretsCache / .secrets.
      expect(getSecret("glm")).toBe("sk-glm-from-env");
      // base_url migrated into the seeded models.yaml.
      const glm = cfg.models.find((m: ModelInfo) => m.id === "glm");
      expect(glm?.base_url).toBe("https://custom.glm.base/api/anthropic");
      // .secrets file persisted on disk.
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(dir, ".secrets"), "utf8")).toContain("glm=sk-glm-from-env");
    } finally {
      if (prevKey === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = prevKey;
      if (prevUrl === undefined) delete process.env.GLM_BASE_URL; else process.env.GLM_BASE_URL = prevUrl;
    }
  });

  it("does NOT migrate GLM_API_KEY when .secrets already exists", async () => {
    writeFileSync(join(dir, ".secrets"), "glm=already-set\n");
    const prevKey = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = "sk-should-be-ignored";
    try {
      const { loadModelsConfig, getSecret } = await import("./model-registry.ts?t=" + Date.now());
      loadModelsConfig(dir);
      // Existing .secrets takes precedence — no overwrite.
      expect(getSecret("glm")).toBe("already-set");
    } finally {
      if (prevKey === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = prevKey;
    }
  });
});
