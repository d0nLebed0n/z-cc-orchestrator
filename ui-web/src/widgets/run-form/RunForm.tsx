"use client";

import { useEffect, useState } from "react";
import { api } from "@/shared/api";
import type { WorkflowDto } from "@/entities";

interface Props {
  /** Активна ли сейчас задача (форма заблокирована). */
  disabled: boolean;
  onStarted: (clientKey: string) => void;
}

export function RunForm({ disabled, onStarted }: Props) {
  const [prompt, setPrompt] = useState("");
  const [workflow, setWorkflow] = useState("default");
  const [project, setProject] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.listWorkflows().then(setWorkflows).catch(() => {});
  }, []);

  async function submit() {
    if (!prompt.trim() || !workflow) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.startTask({
        prompt: prompt.trim(),
        workflow,
        project: project.trim() || undefined,
      });
      onStarted(res.clientKey);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={styles.section}>
      <h2 style={styles.h2}>Запуск задачи</h2>
      <textarea
        placeholder="Опиши задачу: «добавь пагинацию в список пользователей»"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        style={styles.textarea}
        disabled={disabled}
      />
      <div style={styles.row}>
        <label style={styles.field}>
          <span style={styles.label}>Воркфлоу</span>
          <select
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            style={styles.select}
            disabled={disabled}
          >
            {workflows.length === 0 && <option value="default">default</option>}
            {workflows.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.label}>Проект (путь к git-репозиторию)</span>
          <input
            placeholder="/Users/ilyalebedev/Desktop/iva-gang/numbers"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            style={styles.input}
            disabled={disabled}
          />
        </label>
        <button
          onClick={submit}
          disabled={disabled || loading || !prompt.trim()}
          style={{
            ...styles.button,
            ...(disabled || loading || !prompt.trim() ? styles.buttonDisabled : {}),
          }}
        >
          {loading ? "Запуск…" : disabled ? "Занято" : "Запустить"}
        </button>
      </div>
      <div style={styles.hint}>
        Абсолютный путь к <b>корню git-репозитория</b>, не к файлу. Ведущая{" "}
        <code style={styles.code}>~</code> разворачивается в домашнюю директорию.
        Пусто = корень оркестратора. Конкретные файлы для правки описывай в промте —
        воркер работает в корне репо и найдёт их сам.
      </div>
      {error && <div style={styles.error}>{error}</div>}
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
  },
  h2: { margin: "0 0 12px", fontSize: 15, fontWeight: 600, color: "#cdd6f4" },
  textarea: {
    width: "100%",
    background: "#181825",
    border: "1px solid #313244",
    borderRadius: 8,
    color: "#cdd6f4",
    padding: 10,
    fontFamily: "inherit",
    fontSize: 14,
    resize: "vertical" as const,
    marginBottom: 12,
  },
  row: { display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" as const },
  field: { display: "flex", flexDirection: "column" as const, gap: 4, flex: 1, minWidth: 160 },
  label: { fontSize: 12, color: "#a6adc8" },
  select: inputStyle(),
  input: inputStyle(),
  button: {
    background: "#89b4fa",
    color: "#1e1e2e",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 14,
    height: 40,
  },
  buttonDisabled: { opacity: 0.5, cursor: "not-allowed" },
  error: { color: "#f38ba8", fontSize: 13, marginTop: 10 },
  hint: {
    marginTop: 10,
    fontSize: 12,
    color: "#6c7086",
    lineHeight: 1.5,
  },
  code: {
    background: "#181825",
    padding: "1px 5px",
    borderRadius: 4,
    fontFamily: "ui-monospace, monospace",
    fontSize: 11,
    color: "#a6adc8",
  },
};

function inputStyle() {
  return {
    background: "#181825",
    border: "1px solid #313244",
    borderRadius: 8,
    color: "#cdd6f4",
    padding: "8px 10px",
    fontSize: 14,
    height: 40,
  };
}
