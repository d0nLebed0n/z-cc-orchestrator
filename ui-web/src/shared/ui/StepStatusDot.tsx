import type { StepStatus } from "@/entities";

/**
 * Переиспользуемый цветной dot статуса шага (U1, upgrade-2026-07-13.md).
 * Заменяет локальный STATUS_DOT из LiveLog — единая палитра с <Badge>.
 * Running — пульсирует (CSS keyframes pulse из app/globals.css).
 */
const STATUS_COLOR: Record<StepStatus, string> = {
  pending: "#45475a",
  running: "#89b4fa",
  success: "#a6e3a1",
  failed: "#f38ba8",
  escalated_hitl: "#f9e2af",
};

export function StepStatusDot({ status, size = 9 }: { status: StepStatus; size?: number }) {
  const color = STATUS_COLOR[status] ?? "#45475a";
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        animation: status === "running" ? "pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

/** Человекочитаемая метка статуса шага (для tooltip/expand). */
export const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "ожидание",
  running: "выполняется",
  success: "успех",
  failed: "ошибка",
  escalated_hitl: "требует внимания",
};
