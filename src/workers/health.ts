/**
 * Health checks для воркеров (вдохновлено AI-Agents-Orchestrator base.py).
 *
 * Перед первым диспатчем раннер проверяет, что CLI доступен и залогинен —
 * чтобы не ловить краш на таймбоксе воркера. Дёшево: тривиальный вызов,
 * который быстро завершается.
 *
 * Для каждого агента — свой способ проверки:
 *   claude: `claude --version` (бинарник) + проверка что auth доступен
 *           (через env ANTHROPIC_API_KEY или подписку)
 *   codex:  `codex doctor` (диагностика установки, конфига, auth, runtime)
 *   glm:    те же требования что claude + env GLM_BASE_URL/GLM_API_KEY
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { AgentName } from "../families.ts";

const exec = promisify(execFile);

export interface HealthResult {
  agent: AgentName;
  healthy: boolean;
  /** Что проверялось и что не так. */
  checks: { name: string; ok: boolean; detail: string }[];
  /** Человекочитаемая причина, если unhealthy. */
  reason: string | null;
}

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
// Codex переехал из Codex.app в ChatGPT.app (OpenAI merged standalone app).
const CODEX_BIN =
  process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://d0nlebed0n.tail74ba62.ts.net:11434";

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

/** Проверить, что бинарник доступен в PATH (для claude). */
async function checkInPath(cmd: string): Promise<boolean> {
  if (existsSync(cmd)) return true; // абсолютный путь
  const r = await tryRun("which", [cmd], 5000);
  return r.ok && r.stdout.trim().length > 0;
}

// ─── claude ────────────────────────────────────────────────────────────────

async function checkClaude(): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];

  // 1. Бинарник доступен
  const inPath = await checkInPath(CLAUDE_BIN);
  checks.push({
    name: "binary_available",
    ok: inPath,
    detail: inPath ? CLAUDE_BIN : `${CLAUDE_BIN} not found`,
  });

  // 2. Версия (быстрый вызов, проверяет что CLI запускается)
  if (inPath) {
    const v = await tryRun(CLAUDE_BIN, ["--version"], 15000);
    checks.push({
      name: "version_runs",
      ok: v.ok,
      detail: v.ok ? v.stdout.trim().slice(0, 80) : v.stderr.slice(0, 120),
    });
  }

  // 3. Auth: либо ANTHROPIC_API_KEY (env), либо подписка (OAuth/keychain).
  //    Полная проверка OAuth сложна; делаем мягкую — пробуем тривиальный промпт.
  //    Это дорого (~3-5 сек), поэтому только если предыдущие прошли.
  const firstTwoOk = checks.slice(0, 2).every((c) => c.ok);
  if (firstTwoOk) {
    const probe = await tryRun(
      CLAUDE_BIN,
      ["-p", "Reply with: OK", "--output-format", "text"],
      30000,
    );
    checks.push({
      name: "auth_and_responds",
      ok: probe.ok && probe.stdout.includes("OK"),
      detail: probe.ok
        ? "responds"
        : probe.stderr.slice(0, 120) || "no OK in response",
    });
  }

  const healthy = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  return {
    agent: "claude",
    healthy,
    checks,
    reason: healthy
      ? null
      : failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
  };
}

// ─── codex ─────────────────────────────────────────────────────────────────

async function checkCodex(): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];

  // 1. Бинарник
  const inPath = await checkInPath(CODEX_BIN);
  checks.push({
    name: "binary_available",
    ok: inPath,
    detail: inPath ? CODEX_BIN : `${CODEX_BIN} not found (set CODEX_BIN)`,
  });

  // 2. Версия (CLI запускается)
  if (inPath) {
    const v = await tryRun(CODEX_BIN, ["--version"], 15000);
    checks.push({
      name: "version_runs",
      ok: v.ok,
      detail: v.ok ? v.stdout.trim().slice(0, 80) : v.stderr.slice(0, 120),
    });
  }

  // 3. Login status — залогинен ли (ChatGPT или API key).
  //    Не используем `codex doctor` — он падает на TERM=dumb (headless env),
  //    что даёт false positive. `login status` корректно работает без tty.
  //    ВАЖНО: codex пишет "Logged in using ChatGPT" в STDERR, не stdout.
  if (inPath) {
    const login = await tryRun(CODEX_BIN, ["login", "status"], 15000);
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

  const healthy = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  return {
    agent: "codex",
    healthy,
    checks,
    reason: healthy
      ? null
      : failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
  };
}

// ─── glm ───────────────────────────────────────────────────────────────────

async function checkGlm(glmEnv?: Record<string, string>): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];

  // 1. env креды переданы
  const hasEnv =
    !!glmEnv &&
    !!glmEnv.ANTHROPIC_BASE_URL &&
    !!glmEnv.ANTHROPIC_API_KEY;
  checks.push({
    name: "env_credentials",
    ok: hasEnv,
    detail: hasEnv
      ? `base_url=${glmEnv!.ANTHROPIC_BASE_URL}`
      : "GLM_BASE_URL/GLM_API_KEY missing (set in .env.local)",
  });

  // 2. Бинарник claude доступен (glm использует его)
  const inPath = await checkInPath(CLAUDE_BIN);
  checks.push({
    name: "claude_binary",
    ok: inPath,
    detail: inPath ? CLAUDE_BIN : "claude not found",
  });

  // 3. Реальный проб: claude -p с GLM env отвечает.
  if (hasEnv && inPath) {
    const probe = await tryRun(
      CLAUDE_BIN,
      ["-p", "Reply with: OK", "--output-format", "text"],
      30000,
      glmEnv,
    );
    checks.push({
      name: "glm_responds",
      ok: probe.ok && probe.stdout.includes("OK"),
      detail: probe.ok
        ? "responds"
        : probe.stderr.slice(0, 120) || "no OK in response",
    });
  }

  const healthy = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  return {
    agent: "glm",
    healthy,
    checks,
    reason: healthy
      ? null
      : failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
  };
}

// ─── ollama ────────────────────────────────────────────────────────────────

async function checkOllama(): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];
  // 1. base url set
  checks.push({
    name: "base_url",
    ok: !!OLLAMA_BASE_URL,
    detail: OLLAMA_BASE_URL,
  });
  // 2. /api/tags reachable
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: "GET" });
    const ok = res.ok;
    let detail = `HTTP ${res.status}`;
    if (ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);
      detail = `reachable, ${names.length} model(s)`;
    }
    checks.push({ name: "reachable", ok, detail });
  } catch (e) {
    checks.push({ name: "reachable", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  const healthy = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  return {
    agent: "ollama",
    healthy,
    checks,
    reason: healthy ? null : failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
  };
}

// ─── публичный API ─────────────────────────────────────────────────────────

/** Проверить здоровье одного агента. */
export async function checkHealth(
  agent: AgentName,
  glmEnv?: Record<string, string>,
): Promise<HealthResult> {
  switch (agent) {
    case "claude":
      return checkClaude();
    case "codex":
      return checkCodex();
    case "glm":
      return checkGlm(glmEnv);
    case "ollama":
      return checkOllama();
  }
}

/**
 * Проверить здоровье всех агентов, используемых в воркфлоу.
 * Возвращает map agent → HealthResult. Не падает — каждый проверяется отдельно.
 */
export async function checkHealthForAgents(
  agents: AgentName[],
  glmEnv?: Record<string, string>,
): Promise<Map<AgentName, HealthResult>> {
  const results = new Map<AgentName, HealthResult>();
  // Параллельно — проверки независимы.
  const entries = await Promise.all(
    agents.map(async (a) => [a, await checkHealth(a, glmEnv)] as const),
  );
  for (const [a, r] of entries) results.set(a, r);
  return results;
}

/** Человекочитаемый отчёт для CLI. */
export function formatHealthReport(results: Map<AgentName, HealthResult>): string {
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
