"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/shared/api";
import { Badge } from "@/shared/ui/Badge";
import { stepProgress, workflowName, type TaskRecord } from "@/entities";
import { truncate, shortTime } from "@/shared/lib/format";

interface Props {
  refreshKey: number;
  /** Заблокировано ли (задача активна). Кнопки перезапуска скрыты. */
  disabled?: boolean;
  /** Колбэк при перезапуске задачи — пробрасывает clientKey для SSE-стрима. */
  onRestart?: (clientKey: string) => void;
}

/** Статусы, для которых показываем кнопку перезапуска. */
const RESTARTABLE = new Set(["failed", "escalated_hitl"]);

export function TaskList({ refreshKey, disabled, onRestart }: Props) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listTasks();
      setTasks(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function restart(taskId: string) {
    setRestarting(taskId);
    setError(null);
    try {
      const res = await api.restartTask(taskId);
      onRestart?.(res.clientKey);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestarting(null);
    }
  }

  return (
    <section style={styles.section}>
      <div style={styles.header}>
        <h2 style={styles.h2}>История задач</h2>
        <button onClick={load} style={styles.refresh}>обновить</button>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {tasks.length === 0 && !error && (
        <div style={styles.empty}>задач пока нет</div>
      )}
      <div style={styles.list}>
        {tasks.map((t) => {
          const p = stepProgress(t);
          const canRestart = !disabled && RESTARTABLE.has(t.status) && onRestart;
          return (
            <div key={t.id} style={styles.row}>
              <span style={styles.id}>{t.id}</span>
              <Badge status={t.status} />
              <span style={styles.wf}>{workflowName(t)}</span>
              <span style={styles.prog}>{p.ok}/{p.total}</span>
              <span style={styles.time}>{shortTime(t.updated_at)}</span>
              <span style={styles.prompt}>{truncate(t.prompt, 70)}</span>
              {canRestart && (
                <button
                  onClick={() => restart(t.id)}
                  disabled={restarting === t.id}
                  title="Перезапустить задачу"
                  style={styles.restart}
                >
                  {restarting === t.id ? "…" : "↻"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const styles = {
  section: {
    background: "#1e1e2e",
    border: "1px solid #313244",
    borderRadius: 10,
    padding: 16,
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  h2: { margin: 0, fontSize: 15, fontWeight: 600, color: "#cdd6f4" },
  refresh: {
    background: "#313244",
    color: "#cdd6f4",
    border: "1px solid #45475a",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  list: { display: "flex", flexDirection: "column" as const, gap: 4 },
  row: {
    display: "grid",
    gridTemplateColumns: "90px 150px 90px 50px 70px 1fr 36px",
    gap: 10,
    alignItems: "center",
    padding: "6px 8px",
    borderRadius: 6,
    fontSize: 13,
  },
  id: { fontFamily: "monospace", color: "#89b4fa" },
  wf: { color: "#fab387", fontFamily: "monospace", fontSize: 12 },
  prog: { color: "#a6e3a1", fontFamily: "monospace" },
  time: { color: "#6c7086", fontSize: 12 },
  prompt: { color: "#bac2de", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  empty: { color: "#6c7086", padding: "12px 0" },
  error: { color: "#f38ba8", fontSize: 13, marginBottom: 8 },
  restart: {
    background: "#313244",
    color: "#f9e2af",
    border: "1px solid #45475a",
    borderRadius: 6,
    padding: "2px 0",
    fontSize: 14,
    cursor: "pointer",
    lineHeight: 1,
    textAlign: "center" as const,
  },
};
