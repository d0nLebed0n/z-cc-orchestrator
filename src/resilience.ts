/**
 * Resilience: budget cap, circuit breaker, checkpoint (PLAN §4).
 *
 * ВАЖНО (§0): это детерминированная механика в коде раннера, а не «просьба
 * к модели». Раннер стережёт бюджет и прерывает шаг.
 */
import { writeCheckpoint, logEvent } from "./blackboard.ts";
import type { TaskEnvelope } from "./envelope.ts";
import type { WorkerResult } from "./workers/types.ts";

// ─── Budget cap (§4.1) ─────────────────────────────────────────────────────

export interface BudgetState {
  step_id: string;
  attempts: number;
  total_wall_sec: number;
  exhausted: boolean;
}

export function newBudgetState(step_id: string): BudgetState {
  return { step_id, attempts: 0, total_wall_sec: 0, exhausted: false };
}

/** Учесть один запуск воркера в бюджете шага. */
export function consumeBudget(
  state: BudgetState,
  envelope: TaskEnvelope,
  result: WorkerResult,
): BudgetState {
  const next: BudgetState = {
    step_id: state.step_id,
    attempts: state.attempts + 1,
    total_wall_sec: state.total_wall_sec + Math.ceil(result.duration_ms / 1000),
    exhausted: state.exhausted,
  };
  const overSteps = next.attempts >= envelope.budget.max_steps;
  const overWall = next.total_wall_sec >= envelope.budget.wall_time_sec;
  next.exhausted = overSteps || overWall;
  return next;
}

export function budgetRemaining(state: BudgetState, envelope: TaskEnvelope): {
  steps_left: number;
  wall_sec_left: number;
} {
  return {
    steps_left: Math.max(0, envelope.budget.max_steps - state.attempts),
    wall_sec_left: Math.max(0, envelope.budget.wall_time_sec - state.total_wall_sec),
  };
}

// ─── Circuit breaker (§4.2) ────────────────────────────────────────────────

export class CircuitBreaker {
  /** Сколько подряд неуспехов = сгорел (PLAN §6: подобрать на практике). */
  private threshold: number;
  private failures = new Map<string, number>(); // agent → consecutive failures

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  recordFailure(agent: string): boolean {
    const n = (this.failures.get(agent) ?? 0) + 1;
    this.failures.set(agent, n);
    return n >= this.threshold;
  }

  recordSuccess(agent: string): void {
    this.failures.delete(agent);
  }

  isTripped(agent: string): boolean {
    return (this.failures.get(agent) ?? 0) >= this.threshold;
  }

  getFailures(agent: string): number {
    return this.failures.get(agent) ?? 0;
  }
}

// ─── Checkpoint & resume (§4.3) ────────────────────────────────────────────

/**
 * Раннер (НЕ модель) пишет digest после завершения/обрыва шага Codex.
 * Свежая сессия получает его через envelope.context.
 */
export async function checkpointFromResult(
  taskId: string,
  n: number,
  envelope: TaskEnvelope,
  result: WorkerResult,
  root?: string,
): Promise<string> {
  const summary = result.output.slice(0, 4000) || "(empty output)";
  const digest = {
    summary,
    next: result.success
      ? `Continue from step ${envelope.role} (agent ${envelope.agent}).`
      : `Step ${envelope.role} failed (${result.reason}). Retry or escalate.`,
    files_changed: [], // заполняется раннером из git status при наличии
  };
  const path = await writeCheckpoint(taskId, n, digest, root);
  await logEvent(
    {
      task_id: taskId,
      step_id: envelope.id,
      level: result.success ? "info" : "warn",
      kind: "checkpoint",
      message: `checkpoint #${n} written (${result.success ? "success" : "failed"})`,
      data: { reason: result.reason, duration_ms: result.duration_ms },
    },
    root,
  );
  return path;
}

// ─── HITL-эскалация (§4.5) ─────────────────────────────────────────────────

export interface HitlRequest {
  task_id: string;
  step_id: string;
  reason: string;
  detail: unknown;
}

export async function escalateHitl(
  req: HitlRequest,
  root?: string,
): Promise<void> {
  await logEvent(
    {
      task_id: req.task_id,
      step_id: req.step_id,
      level: "error",
      kind: "hitl_escalation",
      message: `HITL: ${req.reason}`,
      data: req.detail,
    },
    root,
  );
}
