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
    // review #38: api-модель обязана иметь provider+base_url.
    // review #51: все 7 ролей обязательны (включая architect).
    writeFileSync(
      join(dir, "models.yaml"),
      `models:\n  - id: custom\n    label: Custom\n    kind: api\n    family: zai\n    provider: anthropic\n    base_url: https://api.example.com\nroles:\n  plan: custom\n  implement: custom\n  review: custom\n  refine: custom\n  fix: custom\n  final: custom\n  architect: custom\ncomplexity_threshold: 40\n`,
    );
    const { loadModelsConfig } = await import("./model-registry.ts?t=" + Date.now());
    const cfg = loadModelsConfig(dir);
    expect(cfg.models[0]!.id).toBe("custom");
    expect(cfg.complexity_threshold).toBe(40);
  });

  // review #51 (review-2026-07-13): целостность каталога.
  it("ModelsConfigSchema rejects duplicate model ids", async () => {
    const { ModelsConfigSchema } = await import("./model-config-dto.ts?t=" + Date.now());
    const cfg = {
      models: [
        { id: "x", label: "X1", kind: "claude-binary", family: "anthropic" },
        { id: "x", label: "X2", kind: "codex-binary", family: "openai" },
      ],
      roles: { plan: "x", implement: "x", review: "x", refine: "x", fix: "x", final: "x", architect: "x" },
      complexity_threshold: 65,
    };
    expect(() => ModelsConfigSchema.parse(cfg)).toThrow(/duplicate model id/);
  });

  it("ModelsConfigSchema rejects missing roles", async () => {
    const { ModelsConfigSchema } = await import("./model-config-dto.ts?t=" + Date.now());
    const cfg = {
      models: [{ id: "x", label: "X", kind: "claude-binary", family: "anthropic" }],
      roles: { plan: "x", implement: "x", review: "x" }, // неполный набор
      complexity_threshold: 65,
    };
    expect(() => ModelsConfigSchema.parse(cfg)).toThrow(/missing required role/);
  });

  it("ModelsConfigSchema rejects dangling role reference", async () => {
    const { ModelsConfigSchema } = await import("./model-config-dto.ts?t=" + Date.now());
    const cfg = {
      models: [{ id: "x", label: "X", kind: "claude-binary", family: "anthropic" }],
      roles: { plan: "x", implement: "x", review: "x", refine: "x", fix: "x", final: "x", architect: "missing" },
      complexity_threshold: 65,
    };
    expect(() => ModelsConfigSchema.parse(cfg)).toThrow(/references unknown model/);
  });

  // review #49: provider=openai ⇒ model обязательно (на уровне каталога).
  it("ModelsConfigSchema rejects api+openai without model", async () => {
    const { ModelsConfigSchema } = await import("./model-config-dto.ts?t=" + Date.now());
    const cfg = {
      models: [{ id: "oai", label: "OAI", kind: "api", family: "openai", provider: "openai", base_url: "https://api.example.com" }],
      roles: { plan: "oai", implement: "oai", review: "oai", refine: "oai", fix: "oai", final: "oai", architect: "oai" },
      complexity_threshold: 65,
    };
    expect(() => ModelsConfigSchema.parse(cfg)).toThrow(/required for provider=openai/);
  });

  // review #38 (review-2026-07-13): discriminated union в ModelInfoSchema.
  // Раньше широкая schema пропускала api без provider/base_url и ollama без model.
  it("rejects api model without provider/base_url (discriminated union)", async () => {
    const { ModelInfoSchema } = await import("./model-config-dto.ts?t=" + Date.now());
    expect(() => ModelInfoSchema.parse({ id: "x", label: "X", kind: "api", family: "zai" })).toThrow();
    expect(() => ModelInfoSchema.parse({ id: "x", label: "X", kind: "api", family: "zai", provider: "anthropic" })).toThrow();
  });

  it("rejects ollama-http model without base_url/model (discriminated union)", async () => {
    const { ModelInfoSchema } = await import("./model-config-dto.ts?t=" + Date.now());
    expect(() => ModelInfoSchema.parse({ id: "x", label: "X", kind: "ollama-http", family: "local" })).toThrow();
    expect(() => ModelInfoSchema.parse({ id: "x", label: "X", kind: "ollama-http", family: "local", base_url: "http://h:11434" })).toThrow();
  });

  it("accepts valid api and ollama models", async () => {
    const { ModelInfoSchema } = await import("./model-config-dto.ts?t=" + Date.now());
    expect(() => ModelInfoSchema.parse({ id: "x", label: "X", kind: "api", family: "zai", provider: "anthropic", base_url: "https://api.example.com" })).not.toThrow();
    expect(() => ModelInfoSchema.parse({ id: "x", label: "X", kind: "ollama-http", family: "local", base_url: "http://h:11434", model: "qwen:30b" })).not.toThrow();
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

  it("migrates GLM_API_KEY when models.yaml already exists", async () => {
    const prevKey = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    try {
      const registry = await import("./model-registry.ts?t=" + Date.now());
      registry.loadModelsConfig(dir);
      registry.resetRegistry();

      process.env.GLM_API_KEY = "sk-glm-after-models-seed";
      registry.loadModelsConfig(dir);

      expect(registry.getSecret("glm")).toBe("sk-glm-after-models-seed");
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(dir, ".secrets"), "utf8")).toContain(
        "glm=sk-glm-after-models-seed",
      );
    } finally {
      if (prevKey === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = prevKey;
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
