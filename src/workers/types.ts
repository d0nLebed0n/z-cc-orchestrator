/**
 * Общие типы для worker-обёрток (PLAN §2.3, §2.5).
 *
 * Воркеры — headless-процессы: получают envelope, делают работу, отдают
 * результат. Раннер проверяет «сигналы успеха» (§2.5) по WorkerResult.
 */
import type { TaskEnvelope } from "../envelope.ts";

export type WorkerExitReason = "ok" | "timeout" | "nonzero_exit" | "no_output" | "no_changes" | "error";

export interface WorkerResult {
  /** Совпал ли exit-код с ожидаемым (0). */
  exit_ok: boolean;
  /** Код возврата процесса. */
  exit_code: number | null;
  /** Захваченный last-message / stdout (сжатый). */
  output: string;
  /** Был ли процесс убит по таймбоксу. */
  timed_out: boolean;
  /** Непустой ли sidecar/вывод. */
  has_output: boolean;
  /** Изменились ли файлы в worktree (для implement/refine/fix). */
  has_changes: boolean | null;
  /** Массив сигналов успеха (детали — в §2.5). */
  signals: { name: string; ok: boolean; detail?: string }[];
  /** Финальный вердикт: все обязательные сигналы прошли. */
  success: boolean;
  /** Причина провала (если success=false). */
  reason: WorkerExitReason | null;
  /** stderr / диагностика. */
  stderr: string;
  /** Milliseconds spent. */
  duration_ms: number;
}

export interface WorkerRunOptions {
  /** Рабочая директория воркера (worktree целевого проекта). */
  cwd: string;
  /** env-переменные поверх process.env (для GLM — base url + key). */
  env?: Record<string, string>;
  /** Дополнительные флаги CLI. */
  extraArgs?: string[];
  /**
   * Override таймаута шага в секундах (review #3).
   * Если задан — воркер использует его вместо envelope.budget.wall_time_sec.
   * Раннер передаёт сюда остаток бюджета (budgetRemaining.wall_sec_left) на
   * ретраях, чтобы суммарное время шага не превышало wall_time_sec.
   */
  wallTimeSecOverride?: number;
}

export type WorkerFn = (envelope: TaskEnvelope, opts: WorkerRunOptions) => Promise<WorkerResult>;
