/**
 * Типы — зеркало src/blackboard.ts оркестратора.
 * Дублируем (а не импортируем), чтобы сохранить развязку слоёв:
 * бэкенд зависит только от контракта state.json, не от TS-кода раннера.
 */

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

export interface BlackboardState {
  tasks: TaskRecord[];
}

/** Воркфлоу, как его отдаёт GET /workflows. */
export interface WorkflowDto {
  name: string;
  description: string;
  /** Человекочитаемая цепочка шагов: "claude(plan) → glm(implement) → codex(review)". */
  steps: string;
}
