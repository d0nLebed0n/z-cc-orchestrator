/**
 * File-blackboard — единственная шина состояния (PLAN §2.2, §4).
 *
 * Каталог .orchestrator/ (в .gitignore):
 *   state.json      — текущее состояние задач/шагов
 *   results/        — sidecar-файлы результатов воркеров (<task>.json)
 *   checkpoints/    — digest-ы раннера после обрыва/завершения шага (<task>-<n>.json)
 *   log/            — structured events (ошибки, сигналы успеха, решения)
 *
 * Раннер — единственный писатель. Воркеры stateless.
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const BLACKBOARD_DIR = ".orchestrator";
const RESULTS_DIR = join(BLACKBOARD_DIR, "results");
const CHECKPOINTS_DIR = join(BLACKBOARD_DIR, "checkpoints");
const LOG_DIR = join(BLACKBOARD_DIR, "log");
const STATE_FILE = join(BLACKBOARD_DIR, "state.json");

export type StepStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "escalated_hitl"; // circuit breaker / merge conflict

export type TaskStatus = "pending" | "running" | "done" | "failed" | "escalated_hitl";

export interface StepRecord {
  id: string;
  task_id: string;
  agent: string;
  family: string;
  role: string;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
  /** Путь к sidecar-файлу результата в results/. */
  result_path: string | null;
  error: string | null;
}

export interface TaskRecord {
  id: string;
  prompt: string;
  workflow: string;
  project: string;
  status: TaskStatus;
  integration_branch: string;
  created_at: string;
  updated_at: string;
  steps: StepRecord[];
}

export interface BlackboardState {
  tasks: TaskRecord[];
}

// ─── low-level IO ──────────────────────────────────────────────────────────

export async function initBlackboard(root = process.cwd()): Promise<void> {
  const dirs = [
    join(root, BLACKBOARD_DIR),
    join(root, RESULTS_DIR),
    join(root, CHECKPOINTS_DIR),
    join(root, LOG_DIR),
  ];
  for (const d of dirs) {
    if (!existsSync(d)) await mkdir(d, { recursive: true });
  }
  if (!existsSync(join(root, STATE_FILE))) {
    await writeFile(join(root, STATE_FILE), JSON.stringify({ tasks: [] }, null, 2));
  }
}

async function readState(root = process.cwd()): Promise<BlackboardState> {
  await initBlackboard(root);
  const raw = await readFile(join(root, STATE_FILE), "utf8");
  return JSON.parse(raw) as BlackboardState;
}

async function writeState(state: BlackboardState, root = process.cwd()): Promise<void> {
  await initBlackboard(root);
  await writeFile(join(root, STATE_FILE), JSON.stringify(state, null, 2));
}

// ─── tasks ─────────────────────────────────────────────────────────────────

export function newTaskId(): string {
  const n = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `T-${n}`;
}

export async function createTask(input: {
  id?: string;
  prompt: string;
  workflow: string;
  project: string;
  status?: TaskStatus;
  steps?: StepRecord[];
  root?: string;
}): Promise<TaskRecord> {
  const root = input.root ?? process.cwd();
  const state = await readState(root);
  const now = new Date().toISOString();
  const id = input.id ?? newTaskId();
  const task: TaskRecord = {
    id,
    prompt: input.prompt,
    workflow: input.workflow,
    project: input.project,
    status: input.status ?? "pending",
    integration_branch: `orch/${id}/integration`,
    created_at: now,
    updated_at: now,
    steps: input.steps ?? [],
  };
  state.tasks.push(task);
  await writeState(state, root);
  return task;
}

export async function getTask(taskId: string, root = process.cwd()): Promise<TaskRecord | null> {
  const state = await readState(root);
  return state.tasks.find((t) => t.id === taskId) ?? null;
}

export async function listTasks(root = process.cwd()): Promise<TaskRecord[]> {
  const state = await readState(root);
  return state.tasks;
}

export async function updateTask(
  taskId: string,
  patch: Partial<TaskRecord>,
  root = process.cwd(),
): Promise<TaskRecord> {
  const state = await readState(root);
  const idx = state.tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) throw new Error(`Task not found: ${taskId}`);
  const existing = state.tasks[idx]!;
  const updated: TaskRecord = {
    ...existing,
    ...patch,
    id: existing.id, // immutable
    created_at: existing.created_at, // immutable
    prompt: patch.prompt ?? existing.prompt,
    workflow: patch.workflow ?? existing.workflow,
    project: patch.project ?? existing.project,
    updated_at: new Date().toISOString(),
  };
  state.tasks[idx] = updated;
  await writeState(state, root);
  return updated;
}

// ─── steps ─────────────────────────────────────────────────────────────────

export async function upsertStep(
  taskId: string,
  step: StepRecord,
  root = process.cwd(),
): Promise<void> {
  const state = await readState(root);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const idx = task.steps.findIndex((s) => s.id === step.id);
  if (idx === -1) task.steps.push(step);
  else task.steps[idx] = step;
  task.updated_at = new Date().toISOString();
  await writeState(state, root);
}

export function newStepId(taskId: string, n: number, iteration = 1): string {
  // iteration > 1 → суффикс #N, чтобы круги цикла не перетирали результаты
  // друг друга в results/ и state.json.
  const base = `${taskId}-S${String(n).padStart(2, "0")}`;
  return iteration > 1 ? `${base}#${iteration}` : base;
}

/** Fan-out подзадача: суффикс ~<subtaskId>, review добавляет r. Сегмент `~`, не `#` (# = итерация цикла). */
export function newSubtaskStepId(baseStepId: string, subtaskId: string, isReview = false): string {
  return `${baseStepId}~${subtaskId}${isReview ? "r" : ""}`;
}

/** Разобрать stepId на сегменты: <base>[#<iteration>][~<subtask>[r]]. */
export interface StepSegments {
  base: string;
  iteration: number | null;
  subtask: string | null;
  isReview: boolean;
}
export function parseStepSegments(stepId: string): StepSegments {
  const tildeIdx = stepId.indexOf("~");
  const hashIdx = stepId.indexOf("#");
  const base = stepId.slice(0, Math.min(
    tildeIdx === -1 ? stepId.length : tildeIdx,
    hashIdx === -1 ? stepId.length : hashIdx,
  ));
  let iteration: number | null = null;
  let subtask: string | null = null;
  let isReview = false;
  if (hashIdx !== -1) {
    const after = stepId.slice(hashIdx + 1, tildeIdx === -1 ? stepId.length : tildeIdx);
    iteration = Number.parseInt(after, 10);
    if (Number.isNaN(iteration)) iteration = null;
  }
  if (tildeIdx !== -1) {
    let after = stepId.slice(tildeIdx + 1);
    if (after.endsWith("r")) { isReview = true; after = after.slice(0, -1); }
    subtask = after || null;
  }
  return { base, iteration, subtask, isReview };
}

// ─── results / checkpoints / log ───────────────────────────────────────────

export async function writeResult(
  taskId: string,
  stepId: string,
  payload: unknown,
  root = process.cwd(),
): Promise<string> {
  await initBlackboard(root);
  const path = join(root, RESULTS_DIR, `${taskId}-${stepId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}

export async function readResult(taskId: string, stepId: string, root = process.cwd()): Promise<unknown | null> {
  const path = join(root, RESULTS_DIR, `${taskId}-${stepId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeCheckpoint(
  taskId: string,
  n: number,
  digest: { summary: string; next: string; files_changed: string[] },
  root = process.cwd(),
): Promise<string> {
  await initBlackboard(root);
  const path = join(root, CHECKPOINTS_DIR, `${taskId}-${n}.json`);
  await writeFile(path, JSON.stringify({ task_id: taskId, n, ...digest, at: new Date().toISOString() }, null, 2));
  return path;
}

export interface LogEvent {
  ts: string;
  task_id: string;
  step_id: string | null;
  level: "info" | "warn" | "error";
  kind: string; // e.g. "signal_check", "circuit_breaker", "merge_conflict"
  message: string;
  data?: unknown;
}

export async function logEvent(ev: Omit<LogEvent, "ts">, root = process.cwd()): Promise<void> {
  await initBlackboard(root);
  const path = join(root, LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...ev });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, line + "\n");
}

// ─── inspection helpers (для ai-task --status) ────────────────────────────

export async function latestTasks(limit = 10, root = process.cwd()): Promise<TaskRecord[]> {
  const tasks = await listTasks(root);
  return [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
}

export async function listLogFiles(root = process.cwd()): Promise<string[]> {
  const dir = join(root, LOG_DIR);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
}
