import type { TaskStatus, StepStatus } from "@/entities";

type AnyStatus = TaskStatus | StepStatus;

const STATUS_COLOR: Record<AnyStatus, string> = {
  pending: "#6b7280",
  running: "#3b82f6",
  success: "#22c55e",
  done: "#22c55e",
  failed: "#ef4444",
  escalated_hitl: "#f59e0b",
};

const STATUS_LABEL: Record<AnyStatus, string> = {
  pending: "ожидание",
  running: "выполняется",
  success: "успех",
  done: "готово",
  failed: "ошибка",
  escalated_hitl: "требует внимания",
};

export function Badge({ status }: { status: AnyStatus }) {
  const color = STATUS_COLOR[status] ?? "#6b7280";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color,
        background: `${color}1a`,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          animation: status === "running" ? "pulse 1.4s ease-in-out infinite" : undefined,
        }}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}
