import { Injectable } from "@nestjs/common";
import { readFile, writeFile, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PATHS } from "./config";
import type { ModelInputDto, UpdateRolesDto } from "./models.dto";

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);
const execFileAsync = promisify(execFile);

interface StoredModel {
  id: string;
  label: string;
  kind: string;
  family: string;
  provider?: string;
  base_url?: string;
  model?: string;
}

interface ModelsConfig {
  models: StoredModel[];
  roles: Record<string, string>;
  complexity_threshold: number;
}

/**
 * Дефолтный конфиг при отсутствии models.yaml.
 * Должен совпадать с DEFAULT_CONFIG в src/model-registry.ts (движок).
 * Сеется и бэкендом, и движком — кто первый обратится к отсутствующему файлу.
 */
const DEFAULT_CONFIG: ModelsConfig = {
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

export interface ModelDto {
  id: string;
  label: string;
  kind: string;
  family: string;
  provider?: string;
  base_url?: string;
  model?: string;
  status: "ready" | "not_found" | "unknown";
}

@Injectable()
export class ModelsService {
  private async readConfig(): Promise<ModelsConfig> {
    if (!existsSync(PATHS.modelsConfig)) {
      // Файла нет — сеем дефолт (4 модели + роли + threshold) и пишем на диск.
      // Консистентно с движком (src/model-registry.ts DEFAULT_CONFIG).
      await this.writeConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    const raw = await readFileAsync(PATHS.modelsConfig, "utf8");
    const parsed = parseYaml(raw) as ModelsConfig;
    // Толерантность к частично-заполненному конфигу (напр. только models без roles).
    return {
      models: parsed.models ?? [],
      roles: parsed.roles ?? {},
      complexity_threshold: parsed.complexity_threshold ?? 65,
    };
  }

  private async writeConfig(cfg: ModelsConfig): Promise<void> {
    // .orchestrator/ может не существовать при первом обращении — создаём.
    mkdirSync(dirname(PATHS.modelsConfig), { recursive: true });
    await writeFileAsync(PATHS.modelsConfig, stringifyYaml(cfg), "utf8");
  }

  private async readSecrets(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!existsSync(PATHS.secretsFile)) return map;
    const raw = await readFileAsync(PATHS.secretsFile, "utf8");
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return map;
  }

  private async writeSecret(id: string, key: string): Promise<void> {
    const existing = await this.readSecrets();
    existing.set(id, key);
    const lines = [...existing.entries()].map(([k, v]) => `${k}=${v}`);
    mkdirSync(dirname(PATHS.secretsFile), { recursive: true });
    await writeFileAsync(PATHS.secretsFile, lines.join("\n") + "\n", "utf8");
  }

  private async deleteSecret(id: string): Promise<void> {
    const existing = await this.readSecrets();
    existing.delete(id);
    const lines = [...existing.entries()].map(([k, v]) => `${k}=${v}`);
    await writeFileAsync(PATHS.secretsFile, lines.join("\n") + "\n", "utf8");
  }

  /**
   * Резолвит путь к бинарнику claude/codex консистентно с движком (health.ts):
   *   1. env CLAUDE_BIN / CODEX_BIN (явный override)
   *   2. стандартные macOS .app пути (Claude/Codex CLI ставятся в /Applications)
   *   3. which <name> — фолбэк (сработает только если бинарник в PATH без алиаса)
   * `which` в не-интерактивном шелле НЕ видит zsh-алиасов из .zshrc, поэтому
   * без шагов 1-2 codex на macOS с .app-установкой не находится.
   */
  private async resolveBinaryPath(
    name: "claude" | "codex",
  ): Promise<{ found: boolean; path?: string }> {
    // 1. env override
    const envVar = name === "claude" ? "CLAUDE_BIN" : "CODEX_BIN";
    if (process.env[envVar]) {
      const p = process.env[envVar]!;
      if (existsSync(p)) return { found: true, path: p };
    }
    // 2. стандартные .app пути (macOS)
    const appPaths =
      name === "claude"
        ? ["/Applications/Claude.app/Contents/Resources/claude"]
        : [
            "/Applications/ChatGPT.app/Contents/Resources/codex", // OpenAI merged standalone
            "/Applications/Codex.app/Contents/Resources/codex",
          ];
    for (const p of appPaths) {
      if (existsSync(p)) return { found: true, path: p };
    }
    // 3. which (фолбэк — PATH без алиасов)
    try {
      const { stdout } = await execFileAsync("which", [name]);
      const p = stdout.trim();
      if (p) return { found: true, path: p };
    } catch {
      // не в PATH
    }
    return { found: false };
  }

  private async statusOf(model: StoredModel): Promise<ModelDto["status"]> {
    if (model.kind === "claude-binary" || model.kind === "codex-binary") {
      const name = model.kind === "claude-binary" ? "claude" : "codex";
      const { found } = await this.resolveBinaryPath(name);
      return found ? "ready" : "not_found";
    }
    // Для api/ollama-http реальная проверка — при запуске задачи.
    return "ready";
  }

  async list(): Promise<ModelDto[]> {
    const cfg = await this.readConfig();
    const out: ModelDto[] = [];
    for (const m of cfg.models) {
      out.push({ ...m, status: await this.statusOf(m) });
    }
    return out;
  }

  async create(input: ModelInputDto): Promise<ModelDto> {
    const cfg = await this.readConfig();
    if (cfg.models.some((m) => m.id === input.id)) {
      throw new Error(`Model '${input.id}' already exists`);
    }
    const stored: StoredModel = {
      id: input.id,
      label: input.label,
      kind: input.kind,
      family: input.family,
      provider: input.provider,
      base_url: input.base_url,
      model: input.model,
    };
    cfg.models.push(stored);
    await this.writeConfig(cfg);
    if (input.api_key) await this.writeSecret(input.id, input.api_key);
    return { ...stored, status: await this.statusOf(stored) };
  }

  async update(id: string, input: Partial<ModelInputDto>): Promise<ModelDto> {
    const cfg = await this.readConfig();
    const idx = cfg.models.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Model '${id}' not found`);
    // api_key lives ONLY in .secrets — never in models.yaml.
    const { api_key, ...rest } = input;
    cfg.models[idx] = { ...cfg.models[idx]!, ...rest } as StoredModel;
    // Если меняется id — обновляем ключ секрета.
    if (input.id && input.id !== id) {
      const secrets = await this.readSecrets();
      const oldKey = secrets.get(id);
      if (oldKey) {
        await this.deleteSecret(id);
        await this.writeSecret(input.id, oldKey);
      }
    }
    if (api_key) await this.writeSecret(input.id ?? id, api_key);
    await this.writeConfig(cfg);
    return { ...cfg.models[idx]!, status: await this.statusOf(cfg.models[idx]!) };
  }

  async remove(id: string): Promise<void> {
    const cfg = await this.readConfig();
    cfg.models = cfg.models.filter((m) => m.id !== id);
    // Убираем из карты ролей, если была назначена.
    for (const [role, mid] of Object.entries(cfg.roles)) {
      if (mid === id) delete cfg.roles[role];
    }
    await this.writeConfig(cfg);
    await this.deleteSecret(id);
  }

  async detectBinary(kind: "claude-binary" | "codex-binary"): Promise<{
    found: boolean;
    path?: string;
    version?: string;
  }> {
    const name = kind === "claude-binary" ? "claude" : "codex";
    const { found, path } = await this.resolveBinaryPath(name);
    if (!found || !path) return { found: false };
    let version: string | undefined;
    try {
      const v = await execFileAsync(path, ["--version"]);
      version = v.stdout.trim().split("\n")[0];
    } catch {
      // version optional
    }
    return { found: true, path, version };
  }

  async updateRoles(dto: UpdateRolesDto): Promise<void> {
    const cfg = await this.readConfig();
    cfg.roles = dto.roles;
    cfg.complexity_threshold = dto.complexity_threshold;
    await this.writeConfig(cfg);
  }

  async getRoles(): Promise<{ roles: Record<string, string>; complexity_threshold: number }> {
    const cfg = await this.readConfig();
    return { roles: cfg.roles ?? {}, complexity_threshold: cfg.complexity_threshold ?? 65 };
  }
}
