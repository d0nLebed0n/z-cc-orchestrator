/**
 * Sidecar результата шага (U6 типизация, upgrade-2026-07-13.md).
 *
 * Контракт results/<taskId>-<stepId>.json, пишется runner'ом через writeResult.
 * U2 (диагностика «упали на шаге X») читает это через api.getStepResult
 * и показывает output/signals в expandable-блоке StepRow.
 */
export interface StepResultSignal {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface StepResult {
  envelope_id: string;
  agent: string;
  role: string;
  /** Вывод воркера (stdout/last-message, уже обрезан до ~8000 char при записи). */
  output: string;
  signals: StepResultSignal[];
  success: boolean;
  reason: string | null;
  duration_ms: number;
  timed_out: boolean;
}
