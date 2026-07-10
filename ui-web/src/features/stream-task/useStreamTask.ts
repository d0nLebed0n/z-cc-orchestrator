"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/shared/api";
import type { TaskRecord } from "@/entities";

export interface LogEntry {
  stream: "stdout" | "stderr";
  line: string;
  ts: string;
}

export interface StreamState {
  lines: LogEntry[];
  taskId: string | null;
  task: TaskRecord | null;
  exited: boolean;
  exitSuccess: boolean;
  error: string | null;
}

/**
 * Подписка на SSE-стрим процесса по clientKey.
 * Возвращает накопленные строки лога, текущую задачу (из state-событий)
 * и флаг завершения.
 */
export function useStreamTask(clientKey: string | null): StreamState & {
  clear: () => void;
} {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [exited, setExited] = useState(false);
  const [exitSuccess, setExitSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!clientKey) return;
    setLines([]);
    setTaskId(null);
    setTask(null);
    setExited(false);
    setExitSuccess(false);
    setError(null);

    const es = new EventSource(api.streamUrl(clientKey));
    esRef.current = es;

    es.addEventListener("log", (e) => {
      const entry = JSON.parse((e as MessageEvent).data) as LogEntry;
      setLines((prev) => {
        const next = [...prev, entry];
        // Ограничиваем лог последними 5000 строками.
        return next.length > 5000 ? next.slice(-5000) : next;
      });
    });

    es.addEventListener("task-id", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { taskId: string };
      setTaskId(data.taskId);
    });

    es.addEventListener("state", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as TaskRecord;
      setTask(data);
    });

    es.addEventListener("exit", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { code: number | null; success: boolean };
      setExited(true);
      setExitSuccess(data.success);
      es.close();
    });

    es.onerror = () => {
      // EventSource переподключается сам; ошибку фиксируем только если уже вышли.
      if (exited) setError("соединение разорвано");
    };

    return () => {
      es.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientKey]);

  return {
    lines,
    taskId,
    task,
    exited,
    exitSuccess,
    error,
    clear: () => setLines([]),
  };
}
