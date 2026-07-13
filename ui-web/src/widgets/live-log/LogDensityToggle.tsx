"use client";

import type { LogEntry } from "@/features/stream-task/useStreamTask";

/**
 * Переключатель плотности лога (U4, upgrade-2026-07-13.md).
 *
 * Compact — только stderr + ключевые маркеры (VERDICT, error, ✓/✗).
 * Normal — stderr + маркеры + WARN/ERROR строки.
 * Verbose — весь stdout/stderr (как раньше).
 *
 * Плюс тумблер «только stderr». Выбор сохраняется в localStorage.
 */
export type Density = "compact" | "normal" | "verbose";

const STORAGE_KEY = "orch-log-density";
const STDERR_KEY = "orch-log-stderr-only";

/** Загрузить плотность из localStorage (default: normal). */
export function loadDensity(): Density {
  if (typeof window === "undefined") return "normal";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "compact" || v === "normal" || v === "verbose" ? v : "normal";
}

export function loadStderrOnly(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STDERR_KEY) === "1";
}

interface Props {
  density: Density;
  setDensity: (d: Density) => void;
  stderrOnly: boolean;
  setStderrOnly: (v: boolean) => void;
}

export function LogDensityToggle({ density, setDensity, stderrOnly, setStderrOnly }: Props) {
  const opts: { key: Density; label: string }[] = [
    { key: "compact", label: "Compact" },
    { key: "normal", label: "Normal" },
    { key: "verbose", label: "Verbose" },
  ];
  return (
    <div style={styles.wrap}>
      <div style={styles.group}>
        {opts.map((o) => (
          <button
            key={o.key}
            onClick={() => setDensity(o.key)}
            style={{ ...styles.btn, ...(density === o.key ? styles.btnActive : {}) }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <button
        onClick={() => setStderrOnly(!stderrOnly)}
        style={{ ...styles.btn, ...(stderrOnly ? styles.btnActive : {}) }}
        title="Показывать только stderr"
      >
        только stderr
      </button>
    </div>
  );
}

/**
 * Отфильтровать строки лога по плотности + stderrOnly.
 * Compact/Normal оставляют stderr полностью + маркеры в stdout.
 */
export function filterLines(
  lines: LogEntry[],
  density: Density,
  stderrOnly: boolean,
): LogEntry[] {
  if (density === "verbose" && !stderrOnly) return lines;
  return lines.filter((l) => {
    if (stderrOnly && l.stream !== "stderr") return false;
    if (density === "verbose") return true;
    // stderr всегда проходит (если stderrOnly не режет выше).
    if (l.stream === "stderr") return true;
    // Compact/Normal — фильтруем stdout по маркерам.
    return isMarkerLine(l.line, density);
  });
}

/** Маркеры, которые оставляем в compact/normal режиме (поверх stderr). */
const COMPACT_MARKERS = ["VERDICT", "✗", "✓", "error:", "Error:", "ERROR", "✘", "failed"];
const NORMAL_MARKERS = [...COMPACT_MARKERS, "warn", "Warn", "WARN", "merge", "circuit breaker"];

function isMarkerLine(line: string, density: Density): boolean {
  const markers = density === "compact" ? COMPACT_MARKERS : NORMAL_MARKERS;
  return markers.some((m) => line.includes(m));
}

const styles = {
  wrap: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const },
  group: { display: "flex", gap: 2, background: "#181825", borderRadius: 6, padding: 2 },
  btn: {
    border: "none",
    background: "transparent",
    color: "#6c7086",
    padding: "4px 10px",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
  },
  btnActive: { background: "#313244", color: "#cdd6f4" },
};
