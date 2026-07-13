/**
 * Self-contained reader .orchestrator/state.json для MCP-сервера (T5).
 *
 * Не импортирует blackboard.ts (чтобы не тянуть runner-зависимости) и не
 * переиспользует NestJS-сервис из ui-backend (тонкий сервер без рефакторинга).
 * Типы зеркалированы — контракт state.json стабилен.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BLACKBOARD_DIR = ".orchestrator";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "escalated_hitl";
export type StepStatus = "pending" | "running" | "success" | "failed" | "escalated_hitl";

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

interface BlackboardState {
  tasks: TaskRecord[];
}

/** Прочитать state.json. Возвращает { tasks: [] } при отсутствии/повреждении. */
export async function readState(root: string = process.cwd()): Promise<BlackboardState> {
  const path = join(root, BLACKBOARD_DIR, "state.json");
  if (!existsSync(path)) return { tasks: [] };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as BlackboardState;
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

/** Найти задачу по id. null если нет. */
export async function getTask(taskId: string, root?: string): Promise<TaskRecord | null> {
  const state = await readState(root);
  return state.tasks.find((t) => t.id === taskId) ?? null;
}

/** Список задач, отсортированный по updated_at desc (свежие первыми). */
export async function listTasks(root?: string): Promise<TaskRecord[]> {
  const state = await readState(root);
  return [...state.tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
