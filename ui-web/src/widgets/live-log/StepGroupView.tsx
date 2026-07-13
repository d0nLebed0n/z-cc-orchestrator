"use client";

import { useState } from "react";
import { StepStatusDot } from "@/shared/ui/StepStatusDot";
import { StepRow } from "./StepRow";
import { type StepGroup, groupStatus } from "@/shared/lib/stepSegments";

interface Props {
  group: StepGroup;
  taskId: string | null;
  /** U3: колбэк фильтра лога по шагу. Прокидывается в StepRow. */
  onFilterByStep?: (stepId: string) => void;
}

/**
 * Группа шагов в степпере (U5, upgrade-2026-07-13.md).
 *
 * Linear-группы — просто StepRow (один шаг).
 * Loop-группы — «Круг N» заголовок + вложенные StepRow.
 * Fan-out-группы — «fan-out: P1, P2» заголовок + вложенные StepRow (подзадачи).
 *
 * Коллапсируемая (кроме linear — там один шаг, раскрывает StepRow сам).
 */
export function StepGroupView({ group, taskId, onFilterByStep }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const status = groupStatus(group.steps);
  const isMulti = group.steps.length > 1;
  const icon = group.kind === "fanout" ? "Ⓕ" : group.kind === "loop" ? "↻" : "•";

  // Линейная группа = один шаг → StepRow без заголовка-обёртки.
  if (!isMulti) {
    return <StepRow step={group.steps[0]!} taskId={taskId} onFilterByStep={onFilterByStep} />;
  }

  return (
    <div style={{ ...styles.group, borderColor: BORDER_COLOR[status] }}>
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={styles.groupHeader}
      >
        <span style={styles.groupIcon}>{icon}</span>
        <span style={{ ...styles.groupLabel, color: TEXT_COLOR[status] }}>
          {group.label}
        </span>
        <span style={styles.groupCount}>{group.steps.length} подзадач</span>
        <span style={styles.chevron}>{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div style={styles.groupBody}>
          {group.steps.map((s) => (
            <StepRow key={s.id} step={s} taskId={taskId} onFilterByStep={onFilterByStep} />
          ))}
        </div>
      )}
    </div>
  );
}

const BORDER_COLOR: Record<string, string> = {
  success: "#313244",
  running: "#89b4fa",
  failed: "#f38ba8",
  pending: "#313244",
};
const TEXT_COLOR: Record<string, string> = {
  success: "#a6e3a1",
  running: "#89b4fa",
  failed: "#f38ba8",
  pending: "#6c7086",
};

const styles = {
  group: {
    border: "1px solid #313244",
    borderRadius: 8,
    marginBottom: 6,
    overflow: "hidden",
    background: "#11111b",
  },
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 10px",
    background: "#181825",
    border: "none",
    borderBottom: "1px solid #313244",
    cursor: "pointer",
    textAlign: "left" as const,
    fontSize: 13,
    color: "#cdd6f4",
    fontWeight: 600,
  },
  groupIcon: { fontSize: 13, color: "#89b4fa" },
  groupLabel: { fontFamily: "monospace" },
  groupCount: { fontSize: 11, color: "#6c7086", marginLeft: "auto" as const },
  chevron: { color: "#6c7086", fontSize: 11 },
  groupBody: { padding: 6, display: "flex", flexDirection: "column" as const, gap: 0 },
};
