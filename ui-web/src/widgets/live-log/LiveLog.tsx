"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/shared/api";
import { useStreamTask } from "@/features/stream-task/useStreamTask";
import { Badge } from "@/shared/ui/Badge";
import { shortTime, durationMs, truncate } from "@/shared/lib/format";

interface Props {
  clientKey: string | null;
  onFinished: () => void;
}

const STATUS_DOT: Record<string, string> = {
  success: "#22c55e",
  running: "#3b82f6",
  failed: "#ef4444",
  pending: "#45475a",
  escalated_hitl: "#f59e0b",
};

export function LiveLog({ clientKey, onFinished }: Props) {
  const stream = useStreamTask(clientKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Автоскролл лога вниз.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [stream.lines]);

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
        <div style={{ flex: 1 }} />
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

      {task && task.steps.length > 0 && (
        <div style={styles.steps}>
          {task.steps.map((s) => (
            <div key={s.id} style={styles.step}>
              <span style={{ ...styles.dot, background: STATUS_DOT[s.status] ?? "#45475a" }} />
              <span style={styles.stepAgent}>{s.agent}({s.role})</span>
              <span style={styles.stepMeta}>
                {shortTime(s.started_at)} · {durationMs(s.started_at, s.finished_at)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div ref={logRef} style={styles.log}>
        {stream.lines.length === 0 && (
          <div style={styles.logEmpty}>ожидание вывода…</div>
        )}
        {stream.lines.map((l, i) => (
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
  steps: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
    padding: "8px 10px",
    background: "#181825",
    borderRadius: 8,
    marginBottom: 10,
  },
  step: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#bac2de" },
  dot: { width: 8, height: 8, borderRadius: "50%" },
  stepAgent: { fontFamily: "monospace", color: "#cdd6f4" },
  stepMeta: { fontSize: 11, color: "#6c7086" },
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
  msg: { marginTop: 10, fontSize: 13, color: "#a6adc8" },
};
