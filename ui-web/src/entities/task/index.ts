export type StepStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "escalated_hitl";

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "escalated_hitl";

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

/** Прогресс шагов задачи: сколько успешно из общего числа. */
export function stepProgress(task: TaskRecord): { ok: number; total: number } {
  const total = task.steps.length;
  const ok = task.steps.filter((s) => s.status === "success").length;
  return { ok, total };
}

/** Короткое имя воркфлоу из полного пути. */
export function workflowName(task: TaskRecord): string {
  return task.workflow.split("/").pop()?.replace(/\.ya?ml$/, "") ?? task.workflow;
}
