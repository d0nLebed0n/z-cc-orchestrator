"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/shared/api";
import { useStreamTask, type LogEntry } from "@/features/stream-task/useStreamTask";
import { Badge } from "@/shared/ui/Badge";
import { shortTime, truncate } from "@/shared/lib/format";
import { stepProgress } from "@/entities";
import { StepRow } from "./StepRow";
import { FailureBanner } from "./FailureBanner";
import { StepGroupView } from "./StepGroupView";
import { LiveSummary } from "./LiveSummary";
import { groupSteps } from "@/shared/lib/stepSegments";
import { tagLinesByStep } from "./logByStep";
import { useExitNotification } from "./useExitNotification";
import {
  LogDensityToggle,
  filterLines,
  loadDensity,
  loadStderrOnly,
  type Density,
} from "./LogDensityToggle";

interface Props {
  clientKey: string | null;
  onFinished: () => void;
}

export function LiveLog({ clientKey, onFinished }: Props) {
  const stream = useStreamTask(clientKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // U4: плотность лога + stderr-only, с сохранением в localStorage.
  const [density, setDensityState] = useState<Density>(loadDensity);
  const [stderrOnly, setStderrOnlyState] = useState<boolean>(loadStderrOnly);
  const setDensity = (d: Density) => {
    setDensityState(d);
    if (typeof window !== "undefined") window.localStorage.setItem("orch-log-density", d);
  };
  const setStderrOnly = (v: boolean) => {
    setStderrOnlyState(v);
    if (typeof window !== "undefined") window.localStorage.setItem("orch-log-stderr-only", v ? "1" : "0");
  };

  // U3: фильтр лога по выбранному шагу (null = без фильтра).
  const [filterStepId, setFilterStepId] = useState<string | null>(null);

  // U7: тикающий таймер для живой сводки (elapsed/ETA).
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!stream.task || stream.exited) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [stream.task, stream.exited]);

  // U8: desktop-уведомления о завершении.
  const notify = useExitNotification(stream.task?.status ?? null, stream.taskId ?? clientKey);

  // U5: группировка шагов (fan-out/циклы). U3: тегирование лога по шагам.
  const groups = useMemo(
    () => (stream.task ? groupSteps(stream.task.steps) : []),
    [stream.task],
  );
  const linesByStep = useMemo(
    () => (stream.task ? tagLinesByStep(stream.lines, stream.task.steps) : new Map<string | null, LogEntry[]>()),
    [stream.lines, stream.task],
  );

  const visibleLines = useMemo(() => {
    const base = filterLines(stream.lines, density, stderrOnly);
    // U3: если выбран шаг — показать только его строки.
    if (filterStepId) return base.filter((l) => linesByStep.has(filterStepId) && linesByStep.get(filterStepId)!.includes(l));
    return base;
  }, [stream.lines, density, stderrOnly, filterStepId, linesByStep]);

  // Автоскролл лога вниз.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visibleLines]);

  // Сообщаем родителю о завершении, чтобы обновить список.
  useEffect(() => {
    if (stream.exited) onFinished();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.exited]);

  if (!clientKey) {
    return (
      <section style={styles.empty}>
        Нет активной задачи. Заполни форму выше и нажми «Запустить».
      </section>
    );
  }

  const task = stream.task;
  const canStop = !stream.exited;
  const canAccept = task?.status === "done";

  async function stop() {
    if (!clientKey) return;
    setBusy(true);
    try {
      await api.stopTask(clientKey);
      setMsg("SIGTERM отправлен");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!stream.taskId) return;
    setBusy(true);
    try {
      const r = await api.acceptTask(stream.taskId);
      setMsg(r.message);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={styles.section}>
      <div style={styles.header}>
        <h2 style={styles.h2}>
          {stream.taskId ?? "запуск…"}
        </h2>
        {task && <Badge status={task.status} />}
        {!task && stream.exited && (
          <Badge status={stream.exitSuccess ? "done" : "failed"} />
        )}
        {task && task.steps.length > 0 && (
          <span style={styles.progress}>
            {stepProgress(task).ok}/{task.steps.length}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {/* U8: тумблер desktop-уведомлений. */}
        <button
          onClick={notify.toggle}
          style={{ ...styles.btn, ...styles.btnGhost, ...(notify.optedIn ? styles.btnGhostActive : {}) }}
          title={notify.optedIn ? "Уведомления включены" : "Включить уведомления о завершении"}
        >
          {notify.optedIn ? "🔔" : "🔕"}
        </button>
        <button
          onClick={stop}
          disabled={!canStop || busy}
          style={{ ...styles.btn, ...styles.btnDanger, ...(canStop ? {} : styles.btnDisabled) }}
        >
          Остановить
        </button>
        <button
          onClick={accept}
          disabled={!canAccept || busy}
          style={{ ...styles.btn, ...styles.btnOk, ...(canAccept ? {} : styles.btnDisabled) }}
        >
          Принять (merge)
        </button>
      </div>

      {/* U7: живая сводка (elapsed / текущий агент / ETA). */}
      {task && <LiveSummary task={task} nowMs={nowMs} />}

      {/* U2: баннер падения. */}
      {task && <FailureBanner task={task} />}

      {/* U5: степпер с группировкой fan-out/циклов. */}
      {task && task.steps.length > 0 && (
        <div style={styles.steps}>
          {groups.map((g) => (
            <StepGroupView
              key={g.key}
              group={g}
              taskId={stream.taskId}
              onFilterByStep={setFilterStepId}
            />
          ))}
        </div>
      )}

      {/* U4: переключатель плотности лога + U3: индикатор фильтра по шагу. */}
      <div style={styles.densityRow}>
        <LogDensityToggle
          density={density}
          setDensity={setDensity}
          stderrOnly={stderrOnly}
          setStderrOnly={setStderrOnly}
        />
        {filterStepId && (
          <button
            onClick={() => setFilterStepId(null)}
            style={styles.filterChip}
          >
            фильтр: шаг ✕
          </button>
        )}
        {visibleLines.length < stream.lines.length && (
          <span style={styles.filterInfo}>
            {visibleLines.length}/{stream.lines.length} строк
          </span>
        )}
      </div>

      <div ref={logRef} style={styles.log}>
        {visibleLines.length === 0 && (
          <div style={styles.logEmpty}>
            {stream.lines.length === 0 ? "ожидание вывода…" : "(нет строк под текущим фильтром)"}
          </div>
        )}
        {visibleLines.map((l, i) => (
          <div
            key={i}
            style={{
              ...styles.logLine,
              color: l.stream === "stderr" ? "#f38ba8" : "#a6adc8",
            }}
          >
            <span style={styles.logTs}>{shortTime(l.ts)}</span>
            <span style={styles.logStream}>{l.stream === "stderr" ? "ERR" : "OUT"}</span>
            <span style={styles.logText}>{l.line}</span>
          </div>
        ))}
      </div>

      {msg && <div style={styles.msg}>{truncate(msg, 200)}</div>}
      {stream.error && <div style={styles.msg}>{stream.error}</div>}
    </section>
  );
}

const styles = {
  section: {
    background: "#1e1e2e",
    border: "1px solid #313244",
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    display: "flex",
    flexDirection: "column" as const,
  },
  empty: {
    background: "#1e1e2e",
    border: "1px dashed #313244",
    borderRadius: 10,
    padding: "32px 16px",
    marginBottom: 16,
    textAlign: "center" as const,
    color: "#6c7086",
  },
  header: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" as const },
  h2: { margin: 0, fontSize: 15, fontWeight: 600, color: "#cdd6f4", fontFamily: "monospace" },
  progress: {
    fontSize: 12,
    color: "#6c7086",
    fontFamily: "monospace",
    background: "#313244",
    padding: "2px 8px",
    borderRadius: 999,
  },
  steps: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 0,
    marginBottom: 10,
  },
  densityRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
    flexWrap: "wrap" as const,
  },
  filterInfo: { fontSize: 11, color: "#6c7086" },
  log: {
    background: "#11111b",
    borderRadius: 8,
    padding: 10,
    maxHeight: 380,
    overflowY: "auto" as const,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12.5,
    lineHeight: 1.5,
  },
  logEmpty: { color: "#6c7086", fontStyle: "italic" },
  logLine: { display: "flex", gap: 8, whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const },
  logTs: { color: "#585b70", flexShrink: 0, width: 64 },
  logStream: { color: "#585b70", flexShrink: 0, width: 28 },
  logText: { flex: 1 },
  btn: {
    border: "none",
    borderRadius: 8,
    padding: "8px 14px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 13,
  },
  btnDanger: { background: "#f38ba8", color: "#1e1e2e" },
  btnOk: { background: "#a6e3a1", color: "#1e1e2e" },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  btnGhost: { background: "transparent", color: "#6c7086", border: "1px solid #313244", fontSize: 14, padding: "6px 10px" },
  btnGhostActive: { color: "#f9e2af", borderColor: "#f9e2af" },
  filterChip: {
    border: "1px solid #89b4fa",
    background: "#89b4fa14",
    color: "#89b4fa",
    borderRadius: 6,
    padding: "3px 9px",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "monospace",
  },
  msg: { marginTop: 10, fontSize: 13, color: "#a6adc8" },
};
