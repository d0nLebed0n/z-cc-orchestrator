import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
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
    architect: "claude",
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
    // Миграция: добавить роль architect, если её нет (новая роль с этого коммита).
    if (!cached.roles.architect) {
      cached.roles.architect = "claude";
      mkdirSync(dirname(modelsPath), { recursive: true });
      writeFileSync(modelsPath, stringifyYaml(cached), "utf8");
    }
  } else {
    cached = structuredClone(DEFAULT_CONFIG);
    // One-time миграция (PLAN §6): при первичном сидинге — если GLM_BASE_URL
    // задан в окружении (.env.local), переносим его в models.yaml для glm.
    if (process.env.GLM_BASE_URL) {
      const glmModel = cached.models.find((m) => m.id === "glm");
      if (glmModel) glmModel.base_url = process.env.GLM_BASE_URL;
    }
    // .orchestrator/ может не существовать в чужом проекте — создаём.
    mkdirSync(dirname(modelsPath), { recursive: true });
    writeFileSync(modelsPath, stringifyYaml(cached), "utf8");
  }
  // Секреты: читаем всегда (могут измениться).
  const secretsPath = join(dir, ".secrets");
  const secretsExisted = existsSync(secretsPath);
  let secretsRaw = "";
  secretsCache = new Map();
  if (secretsExisted) {
    secretsRaw = readFileSync(secretsPath, "utf8");
    for (const line of secretsRaw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        secretsCache.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
    }
  }

  // Миграция (PLAN §6): если GLM_API_KEY ещё не перенесён, забираем его из
  // окружения (.env.local). models.yaml мог быть создан раньше без .secrets,
  // поэтому миграция не должна зависеть от первичного сидинга реестра.
  const glmKey = process.env.GLM_API_KEY;
  if (glmKey && !secretsCache.has("glm")) {
    secretsCache.set("glm", glmKey);
    const prefix = secretsRaw.length === 0 || secretsRaw.endsWith("\n")
      ? secretsRaw
      : `${secretsRaw}\n`;
    writeFileSync(secretsPath, `${prefix}glm=${glmKey}\n`, { encoding: "utf8", mode: 0o600 });
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
