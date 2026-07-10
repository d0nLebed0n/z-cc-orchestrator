"use client";

import { useState } from "react";
import { RunForm } from "@/widgets/run-form/RunForm";
import { LiveLog } from "@/widgets/live-log/LiveLog";
import { TaskList } from "@/widgets/task-list/TaskList";

export default function HomePage() {
  // clientKey активного процесса (или null).
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Счётчик перерисовок списка задач — инкрементируется по завершении.
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
          ai-task <span style={{ color: "#6c7086", fontWeight: 400, fontSize: 14 }}>
            оркестратор Claude / Codex / GLM
          </span>
        </h1>
      </header>

      <RunForm
        disabled={activeKey !== null}
        onStarted={(key) => setActiveKey(key)}
      />

      <LiveLog
        clientKey={activeKey}
        onFinished={() => {
          // review #3 (Codex): сбрасываем activeKey, иначе RunForm остаётся
          // disabled после завершения первой задачи.
          setActiveKey(null);
          setRefreshKey((k) => k + 1);
        }}
      />

      <TaskList refreshKey={refreshKey} />
    </main>
  );
}
