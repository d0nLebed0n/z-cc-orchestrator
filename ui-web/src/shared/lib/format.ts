/** Усечь строку до n символов с многоточием. */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** ISO-время → короткое локальное "ЧЧ:ММ:СС". */
export function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("ru-RU", { hour12: false });
}

/** Миллисекунды между двумя ISO-временами → "1.2s". */
export function durationMs(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
