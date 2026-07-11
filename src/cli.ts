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
import { latestTasks, listLogFiles, BLACKBOARD_DIR } from "./blackboard.ts";
import { checkHealthForAgents, formatHealthReport } from "./workers/health.ts";
import { loadModelsConfig, getModels } from "./model-registry.ts";

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
    "  --init-project         initialize project knowledge directory (architect role)",
    "  --project-slug <slug>  explicit slug for the project (used with --init-project)",
    "",
    "CONFIG (per-project, in <project>/.orchestrator/):",
    "  models.yaml         model catalog (id, kind, family, provider, base_url, model)",
    "  .secrets            <model-id>=<api-key> lines (for api-provider models)",
    "",
    "ENV (read from process.env; .env.local loaded by the CLI):",
    "  OLLAMA_BASE_URL     Ollama OpenAI-compat endpoint (also in models.yaml)",
    "  OLLAMA_MODEL        model id (also in models.yaml)",
    "  CLAUDE_BIN / CODEX_BIN  override binary paths for claude-binary / codex-binary kinds",
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
      "init-project": { type: "boolean", default: false },
      "project-slug": { type: "string" },
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

  // Проект: дефолт = cwd. Разрешаем рано — он нужен для загрузки реестра моделей
  // (<project>/.orchestrator/models.yaml) и для всех путей ниже.
  const project = typeof values.project === "string" ? resolve(values.project) : process.cwd();
  // Загрузить реестр моделей из проекта. loadModelsConfig сеет дефолтный models.yaml
  // при отсутствии и читает .secrets. Без этого getModel/getSecret/dispatchWorker/checkHealth
  // падают с "loadModelsConfig() not called yet".
  loadModelsConfig(join(project, BLACKBOARD_DIR));

  if (values.health) {
    // Проверяем все модели из реестра. checkHealth читает env (base_url/api_key)
    // из реестра + секретов, поэтому GLM_BASE_URL/GLM_API_KEY больше не нужны
    // как отдельный аргумент — они должны лежать в .secrets под id модели.
    const agents = getModels().map((m) => m.id);
    console.log("Checking health of all models...\n");
    const results = await checkHealthForAgents(agents);
    console.log(formatHealthReport(results));
    const unhealthy = [...results.values()].filter((r) => !r.healthy);
    if (unhealthy.length > 0) {
      console.error(`\n✗ ${unhealthy.length} model(s) unhealthy`);
      process.exit(1);
    }
    console.log("\n✓ All models healthy");
    return;
  }
  if (values.accept && typeof values.accept === "string") {
    const taskId = values.accept;
    const res = await acceptTask(project, taskId);
    if (res.ok) {
      console.log(`✓ ${taskId}: merged integration → main`);
    } else {
      console.error(`✗ ${taskId}: merge failed — ${res.message}`);
      process.exit(1);
    }
    return;
  }

  if (values["init-project"]) {
    // ─── Режим инициализации директории знаний проекта ───
    // CLI сам вызывает getOrCreateProject (создаёт запись реестра с правильным slug,
    // включая коллизионный суффикс если нужно), затем запускает workflow project-init
    // (роль architect), парсит JSON-результат и пишет 00-project/*.md.
    // --project-slug опционален: если задан — используем его (regenerate случая),
    // иначе slug берём из getOrCreateProject.
    const { getOrCreateProject, updateProjectStatus, knowledgeDirFor } = await import("./project-knowledge/registry.ts");
    const { copySkeleton } = await import("./project-knowledge/skeleton.ts");
    const { scanProjectStructure, parseArchitectJson, writeProjectFiles } = await import("./project-knowledge/architect.ts");
    const { readResult: readResultBb } = await import("./blackboard.ts");
    const { existsSync: exists } = await import("node:fs");

    // 1. Создать/найти запись реестра → получить slug (с учётом коллизий).
    const explicitSlug = typeof values["project-slug"] === "string" ? values["project-slug"] : undefined;
    let slug: string;
    if (explicitSlug) {
      slug = explicitSlug;
    } else {
      const entry = await getOrCreateProject(project);
      slug = entry.slug;
    }

    // 2. Скопировать скелет (если ещё не скопирован).
    const knowledgeDir = knowledgeDirFor(slug);
    if (!exists(knowledgeDir)) {
      await copySkeleton(knowledgeDir);
    }

    // 3. Запустить workflow project-init.
    const initPrompt = "Analyze this project and generate the 00-project knowledge base files.";
    const workflowPath = join(WORKFLOWS_DIR, "project-init.yaml");
    if (!existsSync(workflowPath)) {
      console.error(`Workflow not found: ${workflowPath}`);
      process.exit(1);
    }
    console.log(`▶ init-project: slug=${slug}`);
    console.log(`▶ project:      ${project}`);

    const result = await runWorkflow({
      workflowPath,
      prompt: initPrompt,
      project,
    });

    if (!result.success) {
      await updateProjectStatus(slug, "failed", `architect workflow failed for task ${result.task.id}`);
      console.error(`\n✗ architect workflow failed. Task: ${result.task.id}`);
      process.exit(1);
    }

    // 4. Post-process: прочитать результат шага discover, распарсить JSON, писать файлы.
    // Шаг discover — единственный в project-init, его stepId = <taskId>-S01.
    const discoverStepId = `${result.task.id}-S01`;
    const raw = await readResultBb(result.task.id, discoverStepId);
    if (!raw || typeof raw !== "object" || !("output" in raw)) {
      await updateProjectStatus(slug, "failed", "architect result missing output");
      console.error(`✗ architect result has no output`);
      process.exit(1);
    }
    const output = String((raw as { output: string }).output);
    const parsed = parseArchitectJson(output);
    if (!parsed) {
      await updateProjectStatus(slug, "failed", `could not parse architect JSON from output (first 200 chars): ${output.slice(0, 200)}`);
      console.error(`✗ could not parse architect JSON`);
      console.error(`  output (first 500): ${output.slice(0, 500)}`);
      process.exit(1);
    }
    await writeProjectFiles(slug, parsed);
    await updateProjectStatus(slug, "ready");

    console.log(`\n✓ project knowledge generated for slug '${slug}'`);
    console.log(`  knowledge dir: ${knowledgeDir}`);
    console.log(`  files written: 00-project/{product,architecture,code-map,glossary,stack-rules}.md`);
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

  // GLM/ollama креды теперь живут в реестре (.orchestrator/models.yaml + .secrets),
  // а OLLAMA_BASE_URL/OLLAMA_MODEL для runOllama выставляет dotenv из .env.local
  // напрямую в process.env. Раннеру больше не нужно передавать env-объекты —
  // dispatchWorker собирает env модели сам из реестра/секретов.
  const result = await runWorkflow({
    workflowPath,
    prompt,
    project,
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
