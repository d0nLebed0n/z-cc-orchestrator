"use client";

import { useEffect, useRef, useState } from "react";

const OPT_IN_KEY = "orch-notify-opt-in";

/**
 * Desktop-уведомления о завершении задачи (U8, upgrade-2026-07-13.md).
 *
 * Opt-in через localStorage + Web Notifications API. Срабатывает при переходе
 * задачи в терминальный статус (done/failed/escalated_hitl).
 *
 * Возвращает состояние opt-in и тумблер. Уведомления шлёт сам хук при
 * изменении `status` (один раз — ref guard от дублей).
 */
export function useExitNotification(
  status: "done" | "failed" | "escalated_hitl" | string | null,
  taskKey: string | null,
) {
  const [optedIn, setOptedIn] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(OPT_IN_KEY) === "1";
  });
  const firedRef = useRef<string | null>(null);

  const toggle = async (): Promise<void> => {
    const next = !optedIn;
    if (next) {
      // Запросить разрешение, если ещё не given.
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") return; // пользователь отказал — не включаем
      }
    }
    setOptedIn(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(OPT_IN_KEY, next ? "1" : "0");
    }
  };

  useEffect(() => {
    if (!optedIn) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (status !== "done" && status !== "failed" && status !== "escalated_hitl") return;
    // Guard: одно уведомление на (status, taskKey). review #13 (review-2026-07-13):
    // хранили только status → после первой done следующая done в том же mounted-
    // компоненте не уведомляла. Теперь ключ включает taskKey (taskId/clientKey).
    const guardKey = `${taskKey ?? "?"}:${status}`;
    if (firedRef.current === guardKey) return;
    firedRef.current = guardKey;

    const title = status === "done" ? "✅ Задача выполнена" : status === "failed" ? "❌ Задача упала" : "⚠ Требует разбора (HITL)";
    const body =
      status === "done"
        ? "Оркестратор завершил задачу. Можно принять (merge)."
        : status === "failed"
          ? "Задача упала. Проверьте степпер и лог."
          : "Задача эскалирована — нужен ручной разбор.";
    try {
      new Notification(title, { body });
    } catch {
      // Safari требует Service Worker для new Notification — молча игнорируем.
    }
  }, [status, taskKey, optedIn]);

  return { optedIn, toggle };
}

/** Кнопка-тумблер opt-in для размещения в header. */
export function NotificationToggle() {
  // Заглушка — реальный toggle живёт в LiveLog через useExitNotification.
  // Компонент вынесен отдельно, если потребуется в других местах.
  return null;
}
