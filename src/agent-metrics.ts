/**
 * Per-agent метрики для динамического роутинга fan-out (T3, upgrade-2026-07-13.md).
 *
 * Раннер — one-process-per-task (`npx tsx cli.ts`), поэтому in-memory sliding window
 * между запусками НЕ работает. Метрики читаются с диска при старте раннера из
 * state.json (всегда есть, один read через listTasks). report.json не используется —
 * тех пока нет у исторических задач, а state.json даёт достаточно для relative
 * comparison агентов.
 *
 * Источник: StepRecord (agent + status + started_at/finished_at). Caveat: шаги,
 * skip'ые circuit breaker'ом, не оставляют StepRecord (раннер early-return'ит до
 * upsertStep) — статистика наблюдаемых исходов, не skip'ов. Для T3 приемлемо.
 */
import { listTasks, type TaskRecord, type StepRecord } from "./blackboard.ts";

export interface AgentStats {
  agent: string;
  /** Всего шагов этим агентом (с наблюдаемым исходом). */
  total: number;
  success: number;
  failed: number;
  escalated: number;
  /** (failed + escalated) / max(total, 1) ∈ [0, 1]. */
  errorRate: number;
  /** Медиана finished − started (мс). null если нет samples с timing. */
  medianDurationMs: number | null;
  /** Сколько шагов с timing (started_at и finished_at оба заданы). */
  samples: number;
}

export interface AgentMetrics {
  stats: Map<string, AgentStats>;
  /** Сколько последних задач учтено (для прозрачности/logging). */
  windowSize: number;
  computedAt: string;
}

/**
 * Загрузить per-agent метрики из state.json.
 *
 * @param root        корень проекта (где .orchestrator/)
 * @param recentTasks сколько последних задач (по updated_at) учитывать.
 *                    Скользящее окно: недавняя деградация весомее старой стабильности.
 *                    0 или undefined = вся история.
 */
export async function loadAgentMetrics(
  root: string = process.cwd(),
  recentTasks = 50,
): Promise<AgentMetrics> {
  const tasks = await listTasks(root);
  // Сортировка по updated_at desc, slice окна.
  const sorted = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const window = recentTasks > 0 ? sorted.slice(0, recentTasks) : sorted;

  // Аккумуляторы per-agent.
  const counts = new Map<string, { success: number; failed: number; escalated: number; total: number; durations: number[] }>();

  for (const task of window) {
    for (const step of task.steps) {
      accumulateStep(counts, step);
    }
  }

  const stats = new Map<string, AgentStats>();
  for (const [agent, c] of counts) {
    const total = c.total;
    const errorRate = total > 0 ? (c.failed + c.escalated) / total : 0;
    const medianDurationMs = c.durations.length > 0 ? median(c.durations) : null;
    stats.set(agent, {
      agent,
      total,
      success: c.success,
      failed: c.failed,
      escalated: c.escalated,
      errorRate,
      medianDurationMs,
      samples: c.durations.length,
    });
  }

  return { stats, windowSize: window.length, computedAt: new Date().toISOString() };
}

/**
 * Роли, для которых принимается routing-решение в fan-out.
 * review #14 (review-2026-07-13): агрегация всех ролей искажает оценку —
 * ошибки модели на review/plan (где промпт/нагрузка иные) влияли на выбор
 * implement-исполнителя. Учитываем только editing-роли: они ближе к семантике
 * routing decision (им для них loadAgentMetrics и вызывается).
 */
const ROUTING_ROLES = new Set(["implement", "refine", "fix"]);

function accumulateStep(
  counts: Map<string, { success: number; failed: number; escalated: number; total: number; durations: number[] }>,
  step: StepRecord,
): void {
  const agent = step.agent;
  if (!agent) return;
  // review New#2 (T1-T5): cache hit НЕ считаем реальным запуском агента —
  // иначе cache-heavy агент выглядит быстрее/надёжнее, не запуская модель.
  if (step.source === "cache") return;
  // review #14 (review-2026-07-13): только editing-роли — оценка routing-
  // кандидата не должна зависеть от success/failure в review/plan.
  if (!ROUTING_ROLES.has(step.role)) return;
  let c = counts.get(agent);
  if (!c) {
    c = { success: 0, failed: 0, escalated: 0, total: 0, durations: [] };
    counts.set(agent, c);
  }
  // pending/running не считаем — у них исход ещё неизвестен.
  if (step.status === "pending" || step.status === "running") return;
  c.total++;
  if (step.status === "success") c.success++;
  else if (step.status === "failed") c.failed++;
  else if (step.status === "escalated_hitl") c.escalated++;
  // timing: только если оба timestamps заданы и duration ≥ 0.
  if (step.started_at && step.finished_at) {
    const ms = new Date(step.finished_at).getTime() - new Date(step.started_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) c.durations.push(ms);
  }
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Score агента для маршрутизации: **ниже = лучше**.
 *
 * Состав: `errorRate * 1000 + normalizedLatency`. errorRate доминирует (вес 1000 —
 * даже крошечная разница в error-rate перевешивает любую latency), latency —
 * тай-брейк при равном errorRate. Нормализация latency в минутах (medianDurationMs / 60_000),
 * чтобы latency-вклад был в сопоставимом с errorRate-разрядами диапазоне для тай-брейка.
 *
 * undefined stats (агент никогда не запускался) → score = 0: НЕ штрафуем за
 * отсутствие истории, даём шанс новому агенту. Это безопаснее, чем бесконечный
 * штраф, который навсегда бы исключил нового агента.
 */
export function scoreAgent(stats: AgentStats | undefined): number {
  if (!stats || stats.total === 0) return 0;
  const latencyScore = stats.medianDurationMs !== null ? stats.medianDurationMs / 60_000 : 0;
  return stats.errorRate * 1000 + latencyScore;
}

export type { TaskRecord, StepRecord };
