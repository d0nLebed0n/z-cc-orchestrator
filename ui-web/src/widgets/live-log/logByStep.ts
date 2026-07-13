import type { LogEntry } from "@/features/stream-task/useStreamTask";
import type { StepRecord } from "@/entities";

/**
 * Тегирование лог-строк шагом (U3, upgrade-2026-07-13.md, вариант A).
 *
 * Backend НЕ шлёт step_id в log-событиях SSE. Поэтому восстанавливаем
 * принадлежность по времени: лог-строка относится к шагу, который был running
 * в момент её ts (started_at ≤ ts < finished_at, либо до следующего шага).
 *
 * Этот подход дешевле правок backend (дока: «Вариант A — дёшево: на фронте
 * маркировать лог-строки текущим running-шагом по времени»), и достаточен для
 * «клик по шагу → фильтр к его выводу».
 */

/**
 * Найти шаг, к которому относится лог-строка, по ts.
 * Возвращает stepId или null (строка вне диапазонов шагов — напр. запуск).
 */
export function stepForLogLine(
  line: LogEntry,
  steps: StepRecord[],
): string | null {
  const ts = new Date(line.ts).getTime();
  if (!Number.isFinite(ts)) return null;

  // Идём по шагам в порядке выполнения. Шаг "владеет" строкой если:
  //   started_at ≤ ts, И (ts < finished_at ИЛИ шаг ещё running).
  // Шаги отсортированы по started_at (runner пишет их по порядку).
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!s.started_at) continue;
    const start = new Date(s.started_at).getTime();
    if (ts < start) continue;
    const end = s.finished_at ? new Date(s.finished_at).getTime() : Number.POSITIVE_INFINITY;
    if (ts < end) return s.id;
  }
  return null;
}

/**
 * Тегировать все строки лога шагами.
 * Возвращает Map<stepId, LogEntry[]> + ключ null для строк вне шагов.
 */
export function tagLinesByStep(
  lines: LogEntry[],
  steps: StepRecord[],
): Map<string | null, LogEntry[]> {
  const byStep = new Map<string | null, LogEntry[]>();
  for (const line of lines) {
    const stepId = stepForLogLine(line, steps);
    const arr = byStep.get(stepId) ?? [];
    arr.push(line);
    byStep.set(stepId, arr);
  }
  return byStep;
}
