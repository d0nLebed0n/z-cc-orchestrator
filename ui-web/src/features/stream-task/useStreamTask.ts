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
  // review Д4 (T1-T5): ref для актуального exited — onerror в замыкании видел
  // устаревший state и никогда не выставлял сообщение о разрыве после завершения.
  const exitedRef = useRef(false);

  useEffect(() => {
    if (!clientKey) return;
    setLines([]);
    setTaskId(null);
    setTask(null);
    setExited(false);
    exitedRef.current = false;
    setExitSuccess(false);
    setError(null);

    const es = new EventSource(api.streamUrl(clientKey));
    esRef.current = es;

    // Безопасный парсинг SSE payload: битый JSON не должен валить listener.
    const parse = <T,>(e: Event): T | null => {
      try {
        return JSON.parse((e as MessageEvent).data) as T;
      } catch {
        return null;
      }
    };

    // session — отправляется бэкендом при подключении (и при reconnect).
    // Без этого listener'а при reconnect UI не получит taskId из snapshot
    // и продолжит показывать «запуск…», accept недоступен (review #5).
    es.addEventListener("session", (e) => {
      const data = parse<{ clientKey: string; taskId: string | null }>(e);
      if (data?.taskId) setTaskId(data.taskId);
    });

    es.addEventListener("log", (e) => {
      const entry = parse<LogEntry>(e);
      if (!entry) return;
      setLines((prev) => {
        const next = [...prev, entry];
        // Ограничиваем лог последними 5000 строками.
        return next.length > 5000 ? next.slice(-5000) : next;
      });
    });

    es.addEventListener("task-id", (e) => {
      const data = parse<{ taskId: string }>(e);
      if (data?.taskId) setTaskId(data.taskId);
    });

    es.addEventListener("state", (e) => {
      const data = parse<TaskRecord>(e);
      if (data) setTask(data);
    });

    es.addEventListener("exit", (e) => {
      const data = parse<{ code: number | null; success: boolean }>(e);
      if (!data) return;
      setExited(true);
      exitedRef.current = true; // review Д4 (T1-T5): актуальное значение для onerror
      setExitSuccess(data.success);
      es.close();
    });

    es.onerror = () => {
      // EventSource переподключается сам; ошибку фиксируем только если уже вышли.
      // review Д4 (T1-T5): читаем из ref, а не из state — state в замыкании устаревший.
      if (exitedRef.current) setError("соединение разорвано");
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
