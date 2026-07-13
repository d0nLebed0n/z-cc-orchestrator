"use client";

import type { TaskRecord, StepRecord } from "@/entities";

interface Props {
  task: TaskRecord;
}

/**
 * Баннер диагностики падения (U2, upgrade-2026-07-13.md).
 *
 * Показывается при наличии failed/escalated шага в задаче.
 * Ядро UX-запроса: «на каком шаге и почему упали» — без необходимости
 * вглядываться в точки степпера. Берёт ПЕРВЫЙ проблемный шаг, показывает
 * agent(role) + первую строку error.
 */
export function FailureBanner({ task }: Props) {
  const problem = task.steps.find(
    (s) => s.status === "failed" || s.status === "escalated_hitl",
  );
  if (!problem) return null;

  const isEscalated = problem.status === "escalated_hitl";
  const accent = isEscalated ? "#f9e2af" : "#f38ba8";
  const firstErrorLine = problem.error ? (problem.error.split("\n")[0] ?? problem.error) : null;

  return (
    <div style={{ ...styles.banner, borderColor: accent, background: `${accent}14` }}>
      <span style={{ ...styles.icon, color: accent }}>{isEscalated ? "⚠" : "✗"}</span>
      <div style={styles.body}>
        <div style={styles.title}>
          Упало на шаге <code style={styles.code}>{problem.agent}({problem.role})</code>
        </div>
        {firstErrorLine && (
          <div style={{ ...styles.detail, color: accent }}>
            {firstErrorLine}
          </div>
        )}
        {isEscalated && (
          <div style={styles.hint}>
            Эскалация (HITL): требуется ручной разбор. Accept недоступен.
          </div>
        )}
        {!problem.error && (
          <div style={styles.hint}>
            Шаг не завершён успешно. Раскройте его в степпере ниже для деталей.
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  banner: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    border: "1px solid",
    borderRadius: 8,
    padding: "10px 12px",
    marginBottom: 10,
  },
  icon: { fontSize: 18, flexShrink: 0, lineHeight: 1.4 },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 13, fontWeight: 600, color: "#cdd6f4" },
  code: {
    fontFamily: "monospace",
    background: "#313244",
    padding: "1px 5px",
    borderRadius: 4,
    fontSize: 12,
  },
  detail: { fontSize: 12, marginTop: 4, fontFamily: "monospace", wordBreak: "break-word" as const },
  hint: { fontSize: 11, color: "#6c7086", marginTop: 4 },
};
