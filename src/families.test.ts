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

  // review #62 (review-2026-07-13): auto-fallback ранее возвращал любую не-local
  // модель — включая семью автора, молча нарушая кросс-семейный инвариант.
  // Теперь при отсутствии чужой семьи бросается CrossFamilyViolation.
  it("pickReviewer throws when no cross-family model exists (no silent same-family)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-fam-same-"));
    try {
      const { loadModelsConfig, resetRegistry } = await import("./model-registry.ts?t=" + Date.now());
      resetRegistry();
      // Реестр только из anthropic-модели — чужой семьи нет.
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(join(dir, ".orchestrator"), { recursive: true });
      writeFileSync(
        join(dir, ".orchestrator", "models.yaml"),
        `models:\n  - id: only-claude\n    label: Only\n    kind: claude-binary\n    family: anthropic\nroles:\n  plan: only-claude\n  implement: only-claude\n  review: only-claude\n  refine: only-claude\n  fix: only-claude\n  final: only-claude\n  architect: only-claude\ncomplexity_threshold: 65\n`,
      );
      loadModelsConfig(join(dir, ".orchestrator"));
      const { pickReviewer, CrossFamilyViolation } = await import("./families.ts?t=" + Date.now());
      // Нет модели чужой семьи → ошибка, а не тихая подмена same-family.
      expect(() => pickReviewer("anthropic")).toThrow(CrossFamilyViolation);
      expect(() => pickReviewer("anthropic")).toThrow(/other than 'anthropic'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
