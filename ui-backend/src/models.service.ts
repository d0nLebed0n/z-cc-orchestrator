import { Injectable } from "@nestjs/common";
import { readFile, writeFile, existsSync } from "node:fs";
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
      // Сеется движком при первом запуске; если файла нет — вернём пустой.
      return { models: [], roles: {}, complexity_threshold: 65 };
    }
    const raw = await readFileAsync(PATHS.modelsConfig, "utf8");
    return parseYaml(raw) as ModelsConfig;
  }

  private async writeConfig(cfg: ModelsConfig): Promise<void> {
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
    await writeFileAsync(PATHS.secretsFile, lines.join("\n") + "\n", "utf8");
  }

  private async deleteSecret(id: string): Promise<void> {
    const existing = await this.readSecrets();
    existing.delete(id);
    const lines = [...existing.entries()].map(([k, v]) => `${k}=${v}`);
    await writeFileAsync(PATHS.secretsFile, lines.join("\n") + "\n", "utf8");
  }

  private async statusOf(model: StoredModel): Promise<ModelDto["status"]> {
    if (model.kind === "claude-binary" || model.kind === "codex-binary") {
      const bin = model.kind === "claude-binary" ? "claude" : "codex";
      try {
        await execFileAsync("which", [bin]);
        return "ready";
      } catch {
        return "not_found";
      }
    }
    // Для api/ollama-http статус "unknown" — реальная проверка при запуске задачи.
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
    const bin = kind === "claude-binary" ? "claude" : "codex";
    try {
      const { stdout } = await execFileAsync("which", [bin]);
      const path = stdout.trim();
      let version: string | undefined;
      try {
        const v = await execFileAsync(bin, ["--version"]);
        version = v.stdout.trim().split("\n")[0];
      } catch {
        // version optional
      }
      return { found: true, path, version };
    } catch {
      return { found: false };
    }
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
