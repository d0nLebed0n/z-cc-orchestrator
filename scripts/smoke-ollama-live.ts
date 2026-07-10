/**
 * Live smoke для локального исполнителя (Ollama) — требует поднятый хост
 * (OLLAMA_BASE_URL). В отличие от smoke-ollama-tools (unit), этот прогон
 * реально зовёт модель и проверяет, что воркер пишет файл end-to-end.
 *
 * Запуск (хост поднят): npx tsx scripts/smoke-ollama-live.ts
 * Не входит в дефолтный smoke-набор — дорогой (сеть + модель).
 */
import { runOllama } from "../src/workers/runOllama.ts";
import { checkHealth } from "../src/workers/health.ts";
import { config as loadEnv } from "dotenv";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

loadEnv({ path: ".env.local" });

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
if (!OLLAMA_BASE_URL) {
  console.error("✗ OLLAMA_BASE_URL not set (см. .env.local). Host must be up.");
  process.exit(1);
}

// ── B2: health live ping ──
console.log("=== health (live) ===");
const h = await checkHealth("ollama");
assert(h.healthy, `ollama healthy (reachable at ${OLLAMA_BASE_URL})`);
const reachable = h.checks.find((c) => c.name === "reachable");
assert(!!reachable && reachable.ok, `reachable: ${reachable?.detail ?? "?"}`);

// ── B1: runOllama live — пишет файл end-to-end ──
console.log("\n=== runOllama (live, writes file) ===");
const cwd = mkdtempSync(join(tmpdir(), "orch-ollama-live-"));
// git init + base commit (воркер проверяет git status для сигнала files_changed)
execFileSync("git", ["init", "-q"], { cwd });
execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
execFileSync("git", ["config", "user.name", "t"], { cwd });
writeFileSync(join(cwd, "README.md"), "# base\n");
execFileSync("git", ["add", "-A"], { cwd });
execFileSync("git", ["commit", "-q", "-m", "base"], { cwd });

const r = await runOllama(
  {
    id: "T-LIVE", agent: "ollama", family: "local", role: "implement",
    prompt: "Create file hello.ts exporting function add(a: number, b: number): number returning a+b. Use the write_file tool. Then a one-line summary.",
    target_paths: ["hello.ts"], context: null, effort: "low", allow_same_family: false,
    budget: { wall_time_sec: 120, max_steps: 2 },
  },
  { cwd },
);

assert(r.success, `runOllama success (reason=${r.reason})`);
assert(r.has_changes === true, `files_changed signal ok`);
assert(existsSync(join(cwd, "hello.ts")), "hello.ts exists in worktree");
const content = readFileSync(join(cwd, "hello.ts"), "utf8");
assert(/add/.test(content) && /number/.test(content), `hello.ts has add function (content: ${content.slice(0, 60).replace(/\n/g, " ")})`);

rmSync(cwd, { recursive: true, force: true });
console.log("\nAll live ollama checks passed.");
