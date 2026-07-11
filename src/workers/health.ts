/**
 * Health checks для воркеров (вдохновлено AI-Agents-Orchestrator base.py).
 *
 * Перед первым диспатчем раннер проверяет, что модель доступна — чтобы не
 * ловить краш на таймбоксе воркера. Дёшево: тривиальный вызов, который быстро
 * завершается.
 *
 * После Task 6.5 проверки диспатчутся по kind модели из реестра:
 *   claude-binary:  `claude --version` (бинарник) + auth probe
 *   codex-binary:   `codex --version` + login status
 *   api/anthropic:  claude binary + env swap (base_url + key из реестра/секретов)
 *   api/openai:     HTTP ping к /v1/models эндпоинта
 *   ollama-http:    GET /api/tags (reachable + модель в каталоге)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { getModel, getSecret } from "../model-registry.ts";

const exec = promisify(execFile);

export interface HealthResult {
  agent: string;
  healthy: boolean;
  /** Что проверялось и что не так. */
  checks: { name: string; ok: boolean; detail: string }[];
  /** Человекочитаемая причина, если unhealthy. */
  reason: string | null;
}

// Runtime-геттеры (review #2): env читается при вызове check*, не при импорте.
// ESM imports в cli.ts выполняются до loadEnv(.env.local) — module-level const
// захватили бы пустой process.env.
const claudeBin = (): string => process.env.CLAUDE_BIN ?? "claude";
// Codex переехал из Codex.app в ChatGPT.app (OpenAI merged standalone app).
const codexBin = (): string =>
  process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex";

/** Запустить команду с таймаутом, вернуть ok + stdout. */
async function tryRun(
  cmd: string,
  args: string[],
  timeoutMs = 15000,
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      timeout: timeoutMs,
      env: { ...process.env, ...env },
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, stdout: "", stderr: msg };
  }
}

/** Проверить, что бинарник доступен в PATH. */
async function checkInPath(cmd: string): Promise<boolean> {
  if (existsSync(cmd)) return true; // абсолютный путь
  const r = await tryRun("which", [cmd], 5000);
  return r.ok && r.stdout.trim().length > 0;
}

/** Свести проверки в HealthResult. */
function summarize(modelId: string, checks: HealthResult["checks"]): HealthResult {
  const healthy = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  return {
    agent: modelId,
    healthy,
    checks,
    reason: healthy ? null : failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
  };
}

// ─── claude-binary / codex-binary ──────────────────────────────────────────

/**
 * Проверка бинарного воркера (claude или codex).
 * @param modelId id модели (для HealthResult.agent)
 * @param name "claude" | "codex" — для логов и выбора post-binary проверки
 * @param bin путь к бинарнику
 */
async function checkBinaryHealth(
  modelId: string,
  name: "claude" | "codex",
  bin: string,
): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];

  // 1. Бинарник доступен
  const inPath = await checkInPath(bin);
  checks.push({
    name: "binary_available",
    ok: inPath,
    detail: inPath ? bin : `${bin} not found${name === "codex" ? " (set CODEX_BIN)" : ""}`,
  });

  // 2. Версия (быстрый вызов, проверяет что CLI запускается)
  if (inPath) {
    const v = await tryRun(bin, ["--version"], 15000);
    checks.push({
      name: "version_runs",
      ok: v.ok,
      detail: v.ok ? v.stdout.trim().slice(0, 80) : v.stderr.slice(0, 120),
    });
  }

  // 3. Auth/login — свой протокол для каждого бинарника.
  const firstTwoOk = checks.slice(0, 2).every((c) => c.ok);
  if (firstTwoOk) {
    if (name === "claude") {
      // Мягкая проверка auth: тривиальный промпт (дорого ~3-5 сек, только если
      // предыдущие прошли). Ловит и ANTHROPIC_API_KEY, и OAuth/подписку.
      const probe = await tryRun(
        bin,
        ["-p", "Reply with: OK", "--output-format", "text"],
        30000,
      );
      checks.push({
        name: "auth_and_responds",
        ok: probe.ok && probe.stdout.includes("OK"),
        detail: probe.ok ? "responds" : probe.stderr.slice(0, 120) || "no OK in response",
      });
    } else {
      // codex: login status. `codex doctor` падает на TERM=dumb (headless),
      // поэтому используем `login status` — он работает без tty.
      // ВАЖНО: codex пишет "Logged in using ChatGPT" в STDERR, не stdout.
      const login = await tryRun(bin, ["login", "status"], 15000);
      const combined = `${login.stdout} ${login.stderr}`;
      const loggedIn = /logged in/i.test(combined);
      checks.push({
        name: "logged_in",
        ok: login.ok && loggedIn,
        detail: loggedIn
          ? combined.trim().slice(0, 80)
          : login.stderr.slice(0, 120) || "not logged in",
      });
    }
  }

  return summarize(modelId, checks);
}

// ─── api / anthropic (GLM-via-claude с env swap) ───────────────────────────

/**
 * Проверка api/anthropic-модели: те же требования что claude (бинарник) +
 * env base_url/api_key (из реестра/секретов) + реальный проб claude -p с env.
 */
async function checkApiAnthropicHealth(
  modelId: string,
  baseUrl: string,
  apiKey: string,
): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];

  // 1. env/креды из реестра+секретов
  const hasEnv = !!baseUrl && !!apiKey;
  checks.push({
    name: "env_credentials",
    ok: hasEnv,
    detail: hasEnv ? `base_url=${baseUrl}` : "base_url/api_key missing (check registry + .secrets)",
  });

  // 2. Бинарник claude доступен (api/anthropic использует его)
  const cbin = claudeBin();
  const inPath = await checkInPath(cbin);
  checks.push({
    name: "claude_binary",
    ok: inPath,
    detail: inPath ? cbin : "claude not found",
  });

  // 3. Реальный проб: claude -p с env-подменой отвечает.
  if (hasEnv && inPath) {
    const env = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: apiKey };
    const probe = await tryRun(
      cbin,
      ["-p", "Reply with: OK", "--output-format", "text"],
      30000,
      env,
    );
    checks.push({
      name: "api_responds",
      ok: probe.ok && probe.stdout.includes("OK"),
      detail: probe.ok ? "responds" : probe.stderr.slice(0, 120) || "no OK in response",
    });
  }

  return summarize(modelId, checks);
}

// ─── api / openai (HTTP ping) ──────────────────────────────────────────────

/**
 * Проверка api/openai-модели: HTTP-пинг к эндпоинту с Bearer-авторизацией.
 * Запрашиваем /v1/models (дёшево, не тратит токены) — если эндпоинт не отдаёт
 * список моделей, считаем модель unhealthy.
 */
async function checkApiOpenAiHealth(
  modelId: string,
  baseUrl: string,
  modelName: string,
): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];

  const apiKey = getSecret(modelId) ?? "";
  const hasCreds = !!baseUrl && !!apiKey && !!modelName;
  checks.push({
    name: "config",
    ok: hasCreds,
    detail: hasCreds
      ? `base_url=${baseUrl}, model=${modelName}`
      : "base_url/model/api_key missing (check registry + .secrets)",
  });

  if (hasCreds) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${baseUrl}/v1/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      const ok = res.ok;
      let detail = `HTTP ${res.status}`;
      if (ok) {
        try {
          const data = (await res.json()) as { data?: { id: string }[] };
          const count = data.data?.length ?? 0;
          const hasModel = (data.data ?? []).some((m) => m.id === modelName);
          detail = hasModel
            ? `reachable, model '${modelName}' listed`
            : `reachable, ${count} model(s) (model '${modelName}' not listed — may still work)`;
        } catch {
          detail = "reachable (non-JSON body)";
        }
      }
      checks.push({ name: "reachable", ok, detail });
    } catch (e) {
      checks.push({
        name: "reachable",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return summarize(modelId, checks);
}

// ─── ollama-http ───────────────────────────────────────────────────────────

/**
 * Проверка ollama-http-модели: base_url из реестра + /api/tags reachable +
 * модель присутствует в каталоге сервера.
 */
async function checkOllamaHealth(
  modelId: string,
  baseUrl: string,
  modelName: string,
): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];

  const hasUrl = !!baseUrl;
  checks.push({
    name: "base_url",
    ok: hasUrl,
    detail: baseUrl || "(missing in registry)",
  });

  if (hasUrl) {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { method: "GET" });
      const ok = res.ok;
      let detail = `HTTP ${res.status}`;
      if (ok) {
        const data = (await res.json()) as { models?: { name: string }[] };
        const names = (data.models ?? []).map((m) => m.name);
        detail = `reachable, ${names.length} model(s)`;
        if (modelName) {
          const hasModel = names.includes(modelName);
          checks.push({
            name: "model_listed",
            ok: hasModel,
            detail: hasModel ? `'${modelName}' present` : `'${modelName}' NOT pulled`,
          });
        }
      }
      checks.push({ name: "reachable", ok, detail });
    } catch (e) {
      checks.push({
        name: "reachable",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return summarize(modelId, checks);
}

// ─── публичный API ─────────────────────────────────────────────────────────

/** Проверить здоровье одной модели по её id из реестра. */
export async function checkHealth(modelId: string): Promise<HealthResult> {
  const model = getModel(modelId);
  if (!model) {
    return {
      agent: modelId,
      healthy: false,
      checks: [{ name: "registry", ok: false, detail: "model not found in registry" }],
      reason: `model '${modelId}' not in registry`,
    };
  }

  switch (model.kind) {
    case "claude-binary":
      return checkBinaryHealth(modelId, "claude", claudeBin());
    case "codex-binary":
      return checkBinaryHealth(modelId, "codex", codexBin());
    case "api": {
      if (model.provider === "anthropic") {
        const key = getSecret(modelId) ?? "";
        return checkApiAnthropicHealth(modelId, model.base_url ?? "", key);
      }
      if (model.provider === "openai") {
        return checkApiOpenAiHealth(modelId, model.base_url ?? "", model.model ?? "");
      }
      return { agent: modelId, healthy: false, checks: [], reason: `unknown provider ${model.provider}` };
    }
    case "ollama-http":
      return checkOllamaHealth(modelId, model.base_url ?? "", model.model ?? "");
    default:
      return { agent: modelId, healthy: false, checks: [], reason: `unknown kind ${(model as { kind: string }).kind}` };
  }
}

/**
 * Проверить здоровье всех моделей, используемых в воркфлоу.
 * Возвращает map modelId → HealthResult. Не падает — каждая проверяется отдельно.
 */
export async function checkHealthForAgents(
  modelIds: string[],
): Promise<Map<string, HealthResult>> {
  const results = new Map<string, HealthResult>();
  // Параллельно — проверки независимы.
  const entries = await Promise.all(
    modelIds.map(async (id) => [id, await checkHealth(id)] as const),
  );
  for (const [id, r] of entries) results.set(id, r);
  return results;
}

/** Человекочитаемый отчёт для CLI. */
export function formatHealthReport(results: Map<string, HealthResult>): string {
  const lines: string[] = [];
  for (const [agent, r] of results) {
    const icon = r.healthy ? "✓" : "✗";
    lines.push(`${icon} ${agent.padEnd(8)} ${r.healthy ? "healthy" : r.reason ?? "unhealthy"}`);
    for (const c of r.checks) {
      const ci = c.ok ? "✓" : "✗";
      lines.push(`           ${ci} ${c.name}: ${c.detail}`);
    }
  }
  return lines.join("\n");
}
