import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ModelsConfigSchema,
  type ModelInfo,
  type ModelsConfig,
} from "./model-config-dto.ts";
import type { Role } from "./envelope.ts";

/** Дефолтный конфиг при отсутствии models.yaml (миграция с захардкоженного AGENTS). */
export const DEFAULT_CONFIG: ModelsConfig = {
  models: [
    { id: "claude", label: "Claude (local)", kind: "claude-binary", family: "anthropic" },
    { id: "codex", label: "Codex (local)", kind: "codex-binary", family: "openai" },
    {
      id: "glm",
      label: "GLM (Z.ai)",
      kind: "api",
      family: "zai",
      provider: "anthropic",
      base_url: "https://api.z.ai/api/anthropic",
    },
    {
      id: "ollama",
      label: "Ollama (Tailscale)",
      kind: "ollama-http",
      family: "local",
      base_url: "http://d0nlebed0n.tail74ba62.ts.net:11434",
      model: "danielsheep/Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS",
    },
  ],
  roles: {
    plan: "claude",
    implement: "glm",
    review: "codex",
    refine: "glm",
    fix: "glm",
    final: "claude",
  },
  complexity_threshold: 65,
};

let cached: ModelsConfig | null = null;
let secretsCache: Map<string, string> | null = null;

/**
 * Загрузить конфиг из директории (.orchestrator/).
 * Если models.yaml отсутствует — сеет дефолт и пишет файл.
 * @param dir директория .orchestrator/ (или temp для тестов)
 */
export function loadModelsConfig(dir: string): ModelsConfig {
  const modelsPath = join(dir, "models.yaml");
  if (existsSync(modelsPath)) {
    const raw = readFileSync(modelsPath, "utf8");
    const parsed = ModelsConfigSchema.parse(parseYaml(raw));
    cached = parsed;
  } else {
    cached = structuredClone(DEFAULT_CONFIG);
    writeFileSync(modelsPath, stringifyYaml(DEFAULT_CONFIG), "utf8");
  }
  // Секреты: читаем всегда (могут измениться).
  const secretsPath = join(dir, ".secrets");
  secretsCache = new Map();
  if (existsSync(secretsPath)) {
    const raw = readFileSync(secretsPath, "utf8");
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        secretsCache.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
    }
  }
  return cached;
}

/** Сбросить кеш (для тестов). */
export function resetRegistry(): void {
  cached = null;
  secretsCache = null;
}

function cfg(): ModelsConfig {
  if (!cached) throw new Error("model-registry: loadModelsConfig() not called yet");
  return cached;
}

export function getModels(): ModelInfo[] {
  return cfg().models;
}

export function getModel(id: string): ModelInfo | undefined {
  return cfg().models.find((m) => m.id === id);
}

export function getRoleMap(): ModelsConfig["roles"] {
  return cfg().roles;
}

export function resolveRole(role: Role): string | undefined {
  return cfg().roles[role];
}

export function getThreshold(): number {
  return cfg().complexity_threshold;
}

export function getSecret(id: string): string | undefined {
  if (!secretsCache) return undefined;
  return secretsCache.get(id);
}
