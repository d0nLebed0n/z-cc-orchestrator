#!/usr/bin/env node
/**
 * ai-task — единая точка входа (PLAN §5).
 *
 *   ai-task "описание" [--workflow <name>] [--project <path>]
 *   ai-task --list                 # список воркфлоу
 *   ai-task --status               # состояние из blackboard
 *   ai-task --accept <task-id>     # приёмка: merge integration → main (§4.5.5)
 *
 * Дефолтный воркфлоу: default. Дефолтный проект: cwd.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { config as loadEnv } from "dotenv";
import { runWorkflow } from "./runner.ts";
import { acceptTask } from "./worktree.ts";
import { latestTasks, listLogFiles } from "./blackboard.ts";
import { checkHealthForAgents, formatHealthReport } from "./workers/health.ts";
import type { AgentName } from "./families.ts";

// Подгрузить .env.local (GLM-креды и т.п.). silent — файла может не быть.
loadEnv({ path: ".env.local" });

const WORKFLOWS_DIR = join(process.cwd(), "workflows");

function usage(): string {
  return [
    "ai-task — orchestration of Claude/Codex/GLM",
    "",
    "USAGE:",
    "  ai-task \"<prompt>\" [--workflow <name>] [--project <path>]",
    "  ai-task --list                 list available workflows",
    "  ai-task --status               show latest tasks from blackboard",
    "  ai-task --health               check all agents are installed & logged in",
    "  ai-task --accept <task-id>     accept task: merge integration → main",
    "",
    "OPTIONS:",
    "  --workflow <name>      workflow yaml in workflows/ (default: default)",
    "  --project <path>       target repo (default: cwd)",
    "  --max-parallel <n>     cap parallel workers (default: workflow max_parallel or 3)",
    "",
    "ENV (for GLM steps):",
    "  GLM_BASE_URL        Z.ai anthropic-compatible endpoint",
    "  GLM_API_KEY         Z.ai API key",
    "",
    "ENV (for Ollama/local steps — read from process.env by the worker):",
    "  OLLAMA_BASE_URL     Ollama OpenAI-compat endpoint",
    "  OLLAMA_MODEL        model id (e.g. danielsheep/Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS)",
  ].join("\n");
}

async function listWorkflows(): Promise<void> {
  if (!existsSync(WORKFLOWS_DIR)) {
    console.log("(no workflows/ directory)");
    return;
  }
  const files = (await readdir(WORKFLOWS_DIR)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const f of files) {
    const raw = await readFile(join(WORKFLOWS_DIR, f), "utf8");
    const wf = parseYaml(raw);
    const name = wf.name ?? f.replace(/\.ya?ml$/, "");
    const desc = wf.description ? String(wf.description).split("\n")[0] : "";
    const steps = Array.isArray(wf.steps) ? wf.steps.map((s: { agent: string; role: string }) => `${s.agent}(${s.role})`).join(" → ") : "?";
    console.log(`${name.padEnd(12)} ${steps.padEnd(50)} ${desc}`);
  }
}

async function showStatus(): Promise<void> {
  const tasks = await latestTasks(10);
  if (tasks.length === 0) {
    console.log("(blackboard empty — no tasks yet)");
    return;
  }
  for (const t of tasks) {
    const ok = t.steps.filter((s) => s.status === "success").length;
    const total = t.steps.length;
    console.log(`${t.id}  [${t.status}]  wf=${t.workflow.split("/").pop()?.replace(/\.ya?ml$/, "")}  steps ${ok}/${total}  ${t.prompt.slice(0, 60)}`);
  }
  const logs = await listLogFiles();
  if (logs.length > 0) {
    console.log(`\nlog files: ${logs.length} (latest: ${logs[0]})`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      workflow: { type: "string", short: "w" },
      project: { type: "string", short: "p" },
      "max-parallel": { type: "string" },
      list: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      health: { type: "boolean", default: false },
      accept: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    console.log(usage());
    process.exit(0);
  }
  if (values.list) {
    await listWorkflows();
    return;
  }
  if (values.status) {
    await showStatus();
    return;
  }
  if (values.health) {
    // Подгрузить GLM env для проверки glm-агента.
    const glmEnv: Record<string, string> = {};
    if (process.env.GLM_BASE_URL) glmEnv.ANTHROPIC_BASE_URL = process.env.GLM_BASE_URL;
    if (process.env.GLM_API_KEY) glmEnv.ANTHROPIC_API_KEY = process.env.GLM_API_KEY;
    // ollama читает OLLAMA_BASE_URL/OLLAMA_MODEL напрямую из process.env (dotenv
    // уже выставил их из .env.local). Если base url задан — добавляем в список.
    const agents: AgentName[] = ["claude", "codex", "glm"];
    if (process.env.OLLAMA_BASE_URL) agents.push("ollama");
    console.log("Checking health of all agents...\n");
    const results = await checkHealthForAgents(agents, Object.keys(glmEnv).length > 0 ? glmEnv : undefined);
    console.log(formatHealthReport(results));
    const unhealthy = [...results.values()].filter((r) => !r.healthy);
    if (unhealthy.length > 0) {
      console.error(`\n✗ ${unhealthy.length} agent(s) unhealthy`);
      process.exit(1);
    }
    console.log("\n✓ All agents healthy");
    return;
  }
  if (values.accept && typeof values.accept === "string") {
    const taskId = values.accept;
    const project = typeof values.project === "string" ? resolve(values.project) : process.cwd();
    const res = await acceptTask(project, taskId);
    if (res.ok) {
      console.log(`✓ ${taskId}: merged integration → main`);
    } else {
      console.error(`✗ ${taskId}: merge failed — ${res.message}`);
      process.exit(1);
    }
    return;
  }

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    console.error(usage());
    process.exit(1);
  }

  const workflowName = typeof values.workflow === "string" ? values.workflow : "default";
  const workflowPath = join(WORKFLOWS_DIR, `${workflowName}.yaml`);
  if (!existsSync(workflowPath)) {
    console.error(`Workflow not found: ${workflowPath}`);
    console.error(`Run 'ai-task --list' to see available workflows.`);
    process.exit(1);
  }

  const project = typeof values.project === "string" ? resolve(values.project) : process.cwd();

  // GLM env: читаем из process.env (GLM_BASE_URL / GLM_API_KEY).
  const glmEnv: Record<string, string> = {};
  if (process.env.GLM_BASE_URL) glmEnv.ANTHROPIC_BASE_URL = process.env.GLM_BASE_URL;
  if (process.env.GLM_API_KEY) glmEnv.ANTHROPIC_API_KEY = process.env.GLM_API_KEY;

  // ollama env: runOllama/checkOllama читают process.env напрямую (dotenv уже
  // выставил их из .env.local), но раннеру нужен объект для health-gate и
  // логирования — собираем из тех же значений.
  const ollamaEnv: Record<string, string> = {};
  if (process.env.OLLAMA_BASE_URL) ollamaEnv.OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
  if (process.env.OLLAMA_MODEL) ollamaEnv.OLLAMA_MODEL = process.env.OLLAMA_MODEL;

  // max-parallel: CLI флаг > воркфлоу max_parallel > 3 (раннер разрешает финал).
  const maxParallelRaw = typeof values["max-parallel"] === "string" ? values["max-parallel"] : undefined;
  const maxParallel = maxParallelRaw ? Number.parseInt(maxParallelRaw, 10) : undefined;
  if (maxParallelRaw !== undefined && (!maxParallel || !Number.isFinite(maxParallel) || maxParallel < 1)) {
    console.error(`Invalid --max-parallel value: '${maxParallelRaw}' (must be a positive integer)`);
    process.exit(1);
  }

  console.log(`▶ workflow: ${workflowName}`);
  console.log(`▶ project:  ${project}`);
  console.log(`▶ prompt:   ${prompt.slice(0, 100)}${prompt.length > 100 ? "…" : ""}`);
  console.log("");

  const result = await runWorkflow({
    workflowPath,
    prompt,
    project,
    glmEnv: Object.keys(glmEnv).length > 0 ? glmEnv : undefined,
    ollamaEnv: Object.keys(ollamaEnv).length > 0 ? ollamaEnv : undefined,
    maxParallel,
  });

  if (result.success) {
    console.log(`\n✓ task ${result.task.id} done. Accept with: ai-task --accept ${result.task.id} --project ${project}`);
  } else {
    console.error(`\n✗ task ${result.task.id} did not complete cleanly. Check: ai-task --status`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
