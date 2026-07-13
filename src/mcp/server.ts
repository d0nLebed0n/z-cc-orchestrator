#!/usr/bin/env node
/**
 * MCP-сервер оркестратора (T5, upgrade-2026-07-13.md).
 *
 * Экспонирует оркестратор как MCP-инструменты для IDE (Claude Code, Cursor):
 *   - list_workflows — список доступных воркфлоу
 *   - run_workflow — запуск воркфлоу (spawn CLI, не блокирует)
 *   - get_status — статус задачи/задач из state.json
 *   - accept_task — приёмка задачи (merge integration → main)
 *
 * Transport: stdio (стандарт для IDE-launched MCP). Запуск: `ai-task-mcp`.
 *
 * Архитектура: тонкий сервер без рефакторинга ui-backend. CLI запускается как
 * subprocess (runWorkflow ставит глобальные signal handlers + in-process mutex —
 * in-process вызов небезопасен). state.json читается напрямую (self-contained reader).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "./zod-to-json.js";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { getTask, listTasks } from "./blackboard-reader.ts";
import { startRunner, runOnce, getSession } from "./runner-spawn.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
/** workflows/ — инъектируем для тестов через WORKFLOWS_DIR_OVERRIDE. */
export const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR
  ? resolve(process.env.WORKFLOWS_DIR)
  : resolve(__dirname, "..", "..", "workflows");

/**
 * review #11 (review-2026-07-13): blackboard root — где runner хранит state.json.
 * Runner spawn'ится с cwd=ORCHESTRATOR_ROOT (см. runner-spawn.ts), поэтому
 * state.json/results/log живут там, а НЕ в target project (--project).
 * get_status по taskId/list читает отсюда. Override через env — для тестов.
 *
 * Функция (не const) — чтобы env читался при вызове, а не при module-load.
 * Vitest с `?t=` cache-bust перевыгружает модуль, но env может быть выставлен
 * позже; функция гарантирует актуальное значение.
 */
export function getBlackboardRoot(): string {
  return process.env.BLACKBOARD_ROOT
    ? resolve(process.env.BLACKBOARD_ROOT)
    : resolve(__dirname, "..", "..");
}

// ─── Zod-схемы входов инструментов ──────────────────────────────────────────

const ListWorkflowsSchema = z.object({}).describe("Список доступных воркфлоу.");

export const RunWorkflowSchema = z.object({
  prompt: z.string().min(1).describe("Описание задачи для оркестратора."),
  // review New#4 (T1-T5): только basename — запрет path traversal через ../.
  workflow: z.string().regex(/^[a-zA-Z0-9_-]+$/, "workflow name must be basename (letters, digits, _, -)").default("default").describe("Имя воркфлоу (basename из workflows/*.yaml, без пути)."),
  project: z.string().optional().describe("Целевой git-репозиторий (абсолютный путь). По умолчанию cwd оркестратора."),
  noCache: z.boolean().default(false).describe("Отключить кэш ответов агентов."),
  noSmartRouting: z.boolean().default(false).describe("Отключить метрики-aware роутинг fan-out."),
});

const GetStatusSchema = z.object({
  // review #4 (T1-T5): clientKey — polled статус запущенной задачи (до появления taskId).
  clientKey: z.string().optional().describe("clientKey из run_workflow — статус запущенной задачи (taskId/exited/output)."),
  taskId: z.string().optional().describe("id задачи (T-XXXXXX). Если опущен — последние задачи."),
  project: z.string().optional().describe("Корень проекта, где .orchestrator/. По умолчанию cwd оркестратора."),
  limit: z.number().int().min(1).max(50).default(10).describe("Сколько последних задач (если taskId/clientKey не задан)."),
});

const AcceptTaskSchema = z.object({
  taskId: z.string().min(1).describe("id задачи для приёмки (должна быть status=done)."),
  project: z.string().min(1).describe("Корень проекта, где работала задача."),
});

// ─── Сервер ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "ai-task-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Список инструментов (для IDE).
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_workflows",
      description: "Список доступных воркфлоу оркестратора (workflows/*.yaml).",
      inputSchema: zodToJsonSchema(ListWorkflowsSchema),
    },
    {
      name: "run_workflow",
      description:
        "Запустить воркфлоу оркестратора. Возвращает clientKey сразу (не блокирует). " +
        "Один воркфлоу за раз. Статус — через get_status.",
      inputSchema: zodToJsonSchema(RunWorkflowSchema),
    },
    {
      name: "get_status",
      description: "Статус задачи по id или список последних задач из blackboard.",
      inputSchema: zodToJsonSchema(GetStatusSchema),
    },
    {
      name: "accept_task",
      description:
        "Приёмка задачи: fast-forward merge integration-ветки в main. " +
        "Задача должна быть status=done.",
      inputSchema: zodToJsonSchema(AcceptTaskSchema),
    },
  ],
}));

// Диспетчер вызовов инструментов.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "list_workflows":
        return toolResult(await handleListWorkflows());
      case "run_workflow": {
        const input = RunWorkflowSchema.parse(args ?? {});
        return toolResult(await handleRunWorkflow(input));
      }
      case "get_status": {
        const input = GetStatusSchema.parse(args ?? {});
        return toolResult(await handleGetStatus(input));
      }
      case "accept_task": {
        const input = AcceptTaskSchema.parse(args ?? {});
        return toolResult(await handleAcceptTask(input));
      }
      default:
        return toolError(`unknown tool: ${name}`);
    }
  } catch (e) {
    return toolError(e instanceof Error ? e.message : String(e));
  }
});

// ─── Handlers ───────────────────────────────────────────────────────────────

interface WorkflowInfo {
  name: string;
  description: string;
  steps: string;
  file: string;
}

export async function handleListWorkflows(): Promise<WorkflowInfo[]> {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  const files = (await readdir(WORKFLOWS_DIR)).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  const out: WorkflowInfo[] = [];
  for (const f of files) {
    const raw = await readFile(join(WORKFLOWS_DIR, f), "utf8");
    const wf = parseYaml(raw) as { name?: string; description?: string; steps?: { agent?: string; role?: string }[] };
    const steps = Array.isArray(wf.steps)
      ? wf.steps.map((s) => `${s.agent ?? "?"}(${s.role ?? "?"})`).join(" → ")
      : "?";
    out.push({
      name: wf.name ?? f.replace(/\.ya?ml$/, ""),
      description: wf.description ? String(wf.description).split("\n")[0]!.trim() : "",
      steps,
      file: f,
    });
  }
  return out;
}

export async function handleRunWorkflow(
  input: z.infer<typeof RunWorkflowSchema>,
): Promise<{ clientKey: string; taskId: string | null; message: string }> {
  const res = startRunner({
    prompt: input.prompt,
    workflow: input.workflow,
    project: input.project ?? process.cwd(),
    noCache: input.noCache,
    noSmartRouting: input.noSmartRouting,
  });
  if (!res.ok) {
    throw new Error(
      `another workflow is already running (active: ${res.activeKey}). Use get_status to monitor, then retry.`,
    );
  }
  // taskId может быть известен не сразу (появляется в stdout раннера). Проверим сессию.
  const session = getSession(res.clientKey);
  return {
    clientKey: res.clientKey,
    taskId: session?.taskId ?? null,
    message: `workflow '${input.workflow}' started. Poll get_status with clientKey/taskId.`,
  };
}

export async function handleGetStatus(
  input: z.infer<typeof GetStatusSchema>,
): Promise<unknown> {
  // review #4 (T1-T5): polling по clientKey — статус запущенной задачи.
  // review New#1 (T1-T5): blackboard root берётся из session (ORCHESTRATOR_ROOT),
  // а НЕ из input.project (target project может быть внешним — state.json там пуст).
  if (input.clientKey) {
    const session = getSession(input.clientKey);
    if (!session) throw new Error(`session ${input.clientKey} not found`);
    const bbRoot = session.blackboardRoot;
    const task = session.taskId ? await getTask(session.taskId, bbRoot) : null;
    return {
      clientKey: session.clientKey,
      taskId: session.taskId,
      exited: session.exited,
      exitCode: session.exitCode,
      success: session.success,
      task: task ? summarizeTask(task) : null,
      // tail вывода для контекста (обрезан в ring buffer).
      stdoutTail: session.stdout.slice(-2000),
    };
  }
  // review #11 (review-2026-07-13): taskId/list тоже читают из blackboard root
  // (ORCHESTRATOR_ROOT), а не из input.project. Runner хранит state.json там,
  // где запускается (cwd=ORCHESTRATOR_ROOT), независимо от --project.
  const root = getBlackboardRoot();
  if (input.taskId) {
    const task = await getTask(input.taskId, root);
    if (!task) throw new Error(`task ${input.taskId} not found`);
    return summarizeTask(task);
  }
  const tasks = await listTasks(root);
  return tasks.slice(0, input.limit).map(summarizeTask);
}

function summarizeTask(task: {
  id: string; status: string; workflow: string; prompt: string;
  steps: { status: string; agent: string; role: string }[];
  created_at: string; updated_at: string;
}): unknown {
  const ok = task.steps.filter((s) => s.status === "success").length;
  return {
    id: task.id,
    status: task.status,
    workflow: task.workflow.split("/").pop()?.replace(/\.ya?ml$/, "") ?? task.workflow,
    steps: `${ok}/${task.steps.length}`,
    prompt: task.prompt.slice(0, 120),
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

export async function handleAcceptTask(
  input: z.infer<typeof AcceptTaskSchema>,
): Promise<{ ok: boolean; message: string }> {
  // CLI --accept сам делает merge --ff-only + cleanup. Блокирует до завершения.
  const res = await runOnce(["--accept", input.taskId, "--project", input.project]);
  return {
    ok: res.ok,
    message: res.output.trim() || (res.ok ? "accepted" : `accept failed (code ${res.code})`),
  };
}

// ─── Helpers для MCP-ответов ─────────────────────────────────────────────────

function toolResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ─── Запуск ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout зарезервирован для MCP JSON-RPC — логи в stderr.
  process.stderr.write("ai-task-mcp: MCP server ready on stdio\n");
}

// review Д2 (T1-T5): entrypoint guard — main() ТОЛЬКО при прямом запуске файла,
// не при импорте (тесты импортируют handlers/schema, не должны подключать stdio).
// Robust: сравниваем канонизированные (realpath) пути — переживает symlink/relative.
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";
const isMainEntry = (() => {
  try {
    const modulePath = _fileURLToPath(import.meta.url);
    const argvEntry = process.argv[1];
    if (!argvEntry) return false;
    // resolve оба через realpath — не бросает если файл существует (он существует).
    const realModule = _realpathSync(modulePath);
    const realArgv = _realpathSync(argvEntry);
    return realModule === realArgv;
  } catch {
    // realpath бросает только если файл не существует — тогда точно не entry.
    return false;
  }
})();
if (isMainEntry) {
  main().catch((e) => {
    process.stderr.write(`ai-task-mcp: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
