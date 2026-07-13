"use client";

import { useState } from "react";
import { api } from "@/shared/api";
import { StepStatusDot, STATUS_LABEL } from "@/shared/ui/StepStatusDot";
import { shortTime, durationMs, truncate } from "@/shared/lib/format";
import type { StepRecord, StepResult } from "@/entities";

interface Props {
  step: StepRecord;
  /** id задачи — нужен для lazy-fetch sidecar'а (api.getStepResult). null во время запуска. */
  taskId: string | null;
  /** U3: колбэк фильтра лога по этому шагу. Если задан — в expand-блоке есть кнопка. */
  onFilterByStep?: (stepId: string) => void;
}

/**
 * Строка степпера стадий (U1) с expandable-диагностикой (U2).
 *
 * Свёрнуто: dot + agent(role) + время + попытки (attempts>1 → предупреждение).
 * Раскрыто (клик): полный step.error + lazy-fetch вывода шага (output/signals).
 *
 * failed/escalated — цветная рамка; running — пульсирующий dot.
 */
export function StepRow({ step, taskId, onFilterByStep }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<StepResult | null>(null);
  const [loadingResult, setLoadingResult] = useState(false);
  const [resultError, setResultError] = useState<string | null>(null);

  const isProblem = step.status === "failed" || step.status === "escalated_hitl";
  const hasRetries = step.attempts > 1;

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    // Lazy-fetch вывода шага при первом раскрытии.
    if (next && !result && !loadingResult && taskId && step.result_path) {
      setLoadingResult(true);
      setResultError(null);
      try {
        const r = await api.getStepResult(taskId, step.id);
        setResult(r);
      } catch (e) {
        setResultError((e as Error).message);
      } finally {
        setLoadingResult(false);
      }
    }
  }

  return (
    <div
      style={{
        ...styles.row,
        ...(isProblem ? { ...styles.rowProblem, borderColor: step.status === "escalated_hitl" ? "#f9e2af" : "#f38ba8" } : {}),
      }}
    >
      <button
        onClick={toggleExpand}
        style={styles.rowMain}
        aria-expanded={expanded}
      >
        <StepStatusDot status={step.status} />
        <span style={styles.agent}>{step.agent}({step.role})</span>
        <span style={styles.meta}>
          {shortTime(step.started_at)} · {durationMs(step.started_at, step.finished_at)}
        </span>
        {hasRetries && (
          <span style={styles.retries} title={`${step.attempts} попыток`}>
            ⚠ {step.attempts}×
          </span>
        )}
        {step.error && !expanded && (
          <span style={styles.errorPreview}>{truncate(step.error.split("\n")[0] ?? step.error, 80)}</span>
        )}
        <span style={styles.chevron}>{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div style={styles.expandBody}>
          {/* U3: фильтр лога по этому шагу. */}
          {onFilterByStep && (
            <button onClick={() => onFilterByStep(step.id)} style={styles.filterLogBtn}>
              Показать лог только этого шага
            </button>
          )}
          {step.error && (
            <div style={styles.errorBlock}>
              <div style={styles.errorTitle}>Ошибка:</div>
              <pre style={styles.pre}>{step.error}</pre>
            </div>
          )}
          {step.status === "escalated_hitl" && (
            <div style={styles.hitlHint}>
              Требует ручного разбора. Accept недоступен — проверьте лог и decide:
              retry, fix вручную или отменить.
            </div>
          )}

          {/* Вывод шага (lazy-fetch sidecar) */}
          {taskId && step.result_path && (
            <div style={styles.outputSection}>
              <div style={styles.outputTitle}>
                Вывод шага {loadingResult ? "(загрузка…)" : ""}
              </div>
              {resultError && <div style={styles.outputError}>не удалось загрузить: {resultError}</div>}
              {result && (
                <>
                  <div style={styles.signalsRow}>
                    {result.signals.map((sig, i) => (
                      <span
                        key={i}
                        style={{ ...styles.signalChip, color: sig.ok ? "#a6e3a1" : "#f38ba8" }}
                        title={sig.detail}
                      >
                        {sig.ok ? "✓" : "✗"} {sig.name}
                      </span>
                    ))}
                    {result.reason && (
                      <span style={styles.reasonChip}>reason: {result.reason}</span>
                    )}
                  </div>
                  {result.output && (
                    <pre style={styles.pre}>
                      {truncate(result.output, 4000)}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  row: {
    border: "1px solid #313244",
    borderRadius: 8,
    marginBottom: 6,
    overflow: "hidden",
    background: "#181825",
  },
  rowProblem: { borderWidth: 1 },
  rowMain: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 10px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left" as const,
    fontSize: 13,
    color: "#bac2de",
  },
  agent: { fontFamily: "monospace", color: "#cdd6f4", flexShrink: 0 },
  meta: { fontSize: 11, color: "#6c7086", flexShrink: 0 },
  retries: { fontSize: 11, color: "#f9e2af", flexShrink: 0, fontWeight: 600 },
  errorPreview: {
    fontSize: 11,
    color: "#f38ba8",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  chevron: { color: "#6c7086", flexShrink: 0, fontSize: 11 },
  expandBody: { padding: "0 10px 10px", borderTop: "1px solid #313244" },
  filterLogBtn: {
    marginTop: 8,
    border: "1px solid #89b4fa",
    background: "#89b4fa14",
    color: "#89b4fa",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "monospace",
  },
  errorBlock: { marginTop: 8 },
  errorTitle: { fontSize: 11, color: "#f38ba8", marginBottom: 4, fontWeight: 600 },
  pre: {
    margin: 0,
    padding: 8,
    background: "#11111b",
    borderRadius: 6,
    fontSize: 12,
    fontFamily: "ui-monospace, monospace",
    color: "#a6adc8",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    maxHeight: 240,
    overflowY: "auto" as const,
  },
  hitlHint: {
    marginTop: 8,
    padding: "6px 8px",
    background: "#f9e2af1a",
    borderRadius: 6,
    fontSize: 12,
    color: "#f9e2af",
  },
  outputSection: { marginTop: 8 },
  outputTitle: { fontSize: 11, color: "#6c7086", marginBottom: 4 },
  outputError: { fontSize: 12, color: "#f38ba8" },
  signalsRow: { display: "flex", gap: 6, flexWrap: "wrap" as const, marginBottom: 6 },
  signalChip: { fontSize: 11, fontFamily: "monospace", fontWeight: 600 },
  reasonChip: { fontSize: 11, color: "#6c7086", fontFamily: "monospace" },
};
