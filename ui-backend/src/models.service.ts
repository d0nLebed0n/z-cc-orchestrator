import { Injectable } from "@nestjs/common";
import { readFile, writeFile, chmod, rename, unlink, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { randomBytes } from "node:crypto";
import { PATHS } from "./config";
import type { ModelInputDto, ModelUpdateDto, UpdateRolesDto } from "./models.dto";

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);
const chmodAsync = promisify(chmod);
const renameAsync = promisify(rename);
const unlinkAsync = promisify(unlink);
const execFileAsync = promisify(execFile);

/**
 * Атомарная запись: временный файл в той же директории + rename (review #3).
 * Для секретов — mode 0600, чтобы другие локальные пользователи не читали ключи (review #8).
 *
 * review #37 (review-2026-07-13): try/catch с unlink(temp) при сбое — иначе при
 * ошибке rename/chmod временный файл (для секретов — с ключами) остаётся сиротой.
 * chmod делается на temp ДО rename (как в src/lib/atomic-write.ts): не подвержен
 * umask и нет окна между rename и chmod, где файл существует с более широкими правами.
 */
async function atomicWriteFile(path: string, data: string, mode?: number): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFileAsync(tmp, data);
    // chmod на temp (не подвержен umask), до rename.
    if (mode !== undefined) await chmodAsync(tmp, mode);
    await renameAsync(tmp, path);
  } catch (e) {
    // review #37: почистить временный файл при сбое.
    await unlinkAsync(tmp).catch(() => {
      // ignore — файла уже может не быть
    });
    throw e;
  }
}

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
  status: "ready" | "not_found" | "unknown" | "missing_credentials" | "invalid_config";
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
    // Атомарная запись (review #3). .orchestrator/ создаётся внутри atomicWriteFile.
    await atomicWriteFile(PATHS.modelsConfig, stringifyYaml(cfg));
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
    // mode 0600 — API-ключи не должны читаться другими локальными пользователями (review #8).
    // Атомарная запись — review #3.
    await atomicWriteFile(PATHS.secretsFile, lines.join("\n") + "\n", 0o600);
  }

  private async deleteSecret(id: string): Promise<void> {
    const existing = await this.readSecrets();
    existing.delete(id);
    const lines = [...existing.entries()].map(([k, v]) => `${k}=${v}`);
    await atomicWriteFile(PATHS.secretsFile, lines.join("\n") + "\n", 0o600);
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
    // review #16 (review-2026-07-13): лёгкий config-check для api/ollama.
    // Раньше всегда "ready" — UI показывал готовность, а health падал только
    // при запуске. Теперь явный missing_credentials/invalid_config.
    if (model.kind === "api") {
      if (!model.base_url) return "invalid_config";
      const secrets = await this.readSecrets();
      if (!secrets.has(model.id)) return "missing_credentials";
      return "ready";
    }
    if (model.kind === "ollama-http") {
      if (!model.base_url || !model.model) return "invalid_config";
      return "ready";
    }
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
    // discriminated union по kind: поля provider/base_url/model/api_key есть
    // только у ollama-http/api. Вытаскиваем безопасно через switch.
    const stored: StoredModel = {
      id: input.id,
      label: input.label,
      kind: input.kind,
      family: input.family,
      ...(input.kind === "api" ? { provider: input.provider, base_url: input.base_url, model: input.model } : {}),
      ...(input.kind === "ollama-http" ? { base_url: input.base_url, model: input.model } : {}),
    };
    // review #28 (review-2026-07-13): snapshot ДО мутации. Раньше prevCfg
    // снимался после push — rollback восстанавливал конфиг С новой моделью.
    const prevCfg = stringifyYaml(cfg);
    cfg.models.push(stored);
    try {
      await this.writeConfig(cfg);
      if (input.kind === "api" && input.api_key) await this.writeSecret(input.id, input.api_key);
    } catch (e) {
      // Откатить config до состояния до create. Secret мог не успеть записаться
      // (writeConfig упал первым) — удаляем на случай, если writeSecret частично прошёл.
      await atomicWriteFile(PATHS.modelsConfig, prevCfg).catch(() => {});
      await this.deleteSecret(input.id).catch(() => {});
      throw e;
    }
    return { ...stored, status: await this.statusOf(stored) };
  }

  async update(id: string, input: ModelUpdateDto): Promise<ModelDto> {
    const cfg = await this.readConfig();
    const idx = cfg.models.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Model '${id}' not found`);
    // review #8 (T1-T5): переименование id запрещено — иначе дубликаты +
    // висящие role references. Схема modelUpdateSchema уже не содержит id,
    // но защищаемся и здесь (defense-in-depth).
    const { api_key, ...rest } = input;
    const existing = cfg.models[idx]!;
    const merged = { ...existing, ...rest } as StoredModel;
    // review #3 (review-2026-07-13): валидация итоговой записи по kind.
    // Без этого binary-модели получают base_url/api_key, ollama — пустой model.
    validateMergedModel(merged);
    // review #28: snapshot обоих артефактов ДО мутации для отката.
    const prevCfg = stringifyYaml(cfg);
    let prevSecret: string | null = null;
    if (api_key) {
      const secrets = await this.readSecrets();
      prevSecret = secrets.has(id) ? secrets.get(id)! : null;
    }
    cfg.models[idx] = merged;
    try {
      if (api_key) await this.writeSecret(id, api_key);
      await this.writeConfig(cfg);
    } catch (e) {
      // Откат обоих артефактов: config и secret к состоянию до update.
      await atomicWriteFile(PATHS.modelsConfig, prevCfg).catch(() => {});
      if (api_key) {
        if (prevSecret !== null) await this.writeSecret(id, prevSecret).catch(() => {});
        else await this.deleteSecret(id).catch(() => {});
      }
      throw e;
    }
    return { ...cfg.models[idx]!, status: await this.statusOf(cfg.models[idx]!) };
  }

  async remove(id: string): Promise<void> {
    const cfg = await this.readConfig();
    // review #28: snapshot до мутации. Удаляем config и secret; при сбое
    // deleteSecret восстанавливаем config, чтобы не осталось dangling model
    // без возможности повторного удаления.
    const prevCfg = stringifyYaml(cfg);
    cfg.models = cfg.models.filter((m) => m.id !== id);
    // Убираем из карты ролей, если была назначена.
    for (const [role, mid] of Object.entries(cfg.roles)) {
      if (mid === id) delete cfg.roles[role];
    }
    try {
      await this.writeConfig(cfg);
      await this.deleteSecret(id);
    } catch (e) {
      // Откатить config до состояния до remove (секрет уже мог удалиться —
      // это приемлемо: модель удалена, ключа нет; или ключ остался — orphan,
      // но менее критично, чем dangling model без отката).
      await atomicWriteFile(PATHS.modelsConfig, prevCfg).catch(() => {});
      throw e;
    }
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
    // Связность: каждая роль должна указывать на существующую модель (review #7).
    const knownIds = new Set(cfg.models.map((m) => m.id));
    for (const [role, mid] of Object.entries(dto.roles)) {
      if (!knownIds.has(mid)) {
        throw new Error(`role '${role}' references unknown model '${mid}'`);
      }
    }
    cfg.roles = dto.roles;
    cfg.complexity_threshold = dto.complexity_threshold;
    await this.writeConfig(cfg);
  }

  async getRoles(): Promise<{ roles: Record<string, string>; complexity_threshold: number }> {
    const cfg = await this.readConfig();
    return { roles: cfg.roles ?? {}, complexity_threshold: cfg.complexity_threshold ?? 65 };
  }
}

/**
 * Валидация итоговой модели после merge update'а.
 * review #3 (review-2026-07-13): без этого binary-модели получают base_url/api_key,
 * ollama — пустой model, api — невалидный base_url.
 */
function validateMergedModel(m: StoredModel): void {
  if (m.kind === "claude-binary" || m.kind === "codex-binary") {
    if (m.base_url || m.model || m.provider) {
      throw new Error(`Model '${m.id}' is kind=${m.kind}: base_url/model/provider are not allowed for binary models`);
    }
  } else if (m.kind === "ollama-http") {
    if (!m.base_url) throw new Error(`Model '${m.id}' is kind=ollama-http: base_url is required`);
    if (!m.model) throw new Error(`Model '${m.id}' is kind=ollama-http: model is required (cannot be empty)`);
  } else if (m.kind === "api") {
    if (!m.base_url) throw new Error(`Model '${m.id}' is kind=api: base_url is required`);
    if (!m.provider) throw new Error(`Model '${m.id}' is kind=api: provider is required`);
  }
}
