"use client";

import type { TaskRecord } from "@/entities";

interface Props {
  task: TaskRecord;
  /** ms с момента старта задачи (обновляется тикающим таймером в LiveLog). */
  nowMs: number;
}

/**
 * Компактная живая сводка прогресса (U7, upgrade-2026-07-13.md).
 *
 * Показывает: прошедшее время, текущий running-агент, сколько шагов осталось,
 * простой ETA (на основе среднего времени завершённых шагов той же роли).
 * При падении — «остановлено на X/Y».
 */
export function LiveSummary({ task, nowMs }: Props) {
  if (task.steps.length === 0) return null;

  const total = task.steps.length;
  const done = task.steps.filter((s) => s.status === "success" || s.status === "failed" || s.status === "escalated_hitl").length;
  const running = task.steps.find((s) => s.status === "running");
  const isTerminal = task.status === "done" || task.status === "failed" || task.status === "escalated_hitl";

  // Elapsed: min(started_at) → now (или max(finished_at) если терминальная).
  const starts = task.steps.map((s) => s.started_at).filter((t): t is string => !!t);
  const startMs = starts.length > 0 ? Math.min(...starts.map((t) => new Date(t).getTime())) : null;
  const finishes = task.steps.map((s) => s.finished_at).filter((t): t is string => !!t);
  const endMs = isTerminal && finishes.length > 0 ? Math.max(...finishes.map((t) => new Date(t).getTime())) : nowMs;
  const elapsedMs = startMs !== null ? Math.max(0, endMs - startMs) : 0;

  // Простой ETA: средняя длительность завершённого шага × кол-во оставшихся.
  const remaining = total - done;
  const completedDurations = task.steps
    .filter((s) => s.started_at && s.finished_at && s.status === "success")
    .map((s) => new Date(s.finished_at!).getTime() - new Date(s.started_at!).getTime());
  const avgMs = completedDurations.length > 0
    ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
    : null;
  const etaMs = !isTerminal && remaining > 0 && avgMs !== null ? avgMs * remaining : null;

  const parts: string[] = [];
  parts.push(`⏱ ${fmtDur(elapsedMs)}`);
  if (running) parts.push(`▶ ${running.agent}(${running.role})`);
  if (!isTerminal) {
    parts.push(`осталось ${remaining}/${total}`);
    if (etaMs !== null) parts.push(`ETA ~${fmtDur(etaMs)}`);
  } else {
    parts.push(`остановлено на ${done}/${total}`);
  }

  return (
    <div style={styles.wrap}>
      {parts.map((p, i) => (
        <span key={i} style={styles.chip}>{p}</span>
      ))}
    </div>
  );
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

const styles = {
  wrap: { display: "flex", gap: 8, flexWrap: "wrap" as const, marginBottom: 8 },
  chip: {
    fontSize: 11.5,
    fontFamily: "monospace",
    color: "#a6adc8",
    background: "#181825",
    padding: "3px 9px",
    borderRadius: 6,
  },
};
