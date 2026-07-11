import { API_URL } from "../config";
import type { ModelDto, TaskRecord, WorkflowDto } from "@/entities";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listWorkflows: () => json<WorkflowDto[]>("/workflows"),

  listTasks: () => json<TaskRecord[]>("/tasks"),
  getTask: (id: string) => json<TaskRecord>(`/tasks/${id}`),
  getStepResult: (id: string, stepId: string) =>
    json<unknown>(`/tasks/${id}/steps/${stepId}/result`),

  /** Запустить задачу. Возвращает clientKey для подписки на SSE. */
  startTask: (body: { prompt: string; workflow: string; project?: string }) =>
    json<{ clientKey: string; taskId: null }>("/processes", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  stopTask: (key: string) =>
    json<{ ok: boolean }>(`/processes/${encodeURIComponent(key)}/stop`, {
      method: "POST",
    }),

  acceptTask: (id: string) =>
    json<{ ok: boolean; message: string }>(`/tasks/${encodeURIComponent(id)}/accept`, {
      method: "POST",
    }),

  listModels: () => json<ModelDto[]>("/models"),

  createModel: (body: {
    id: string;
    label: string;
    kind: ModelDto["kind"];
    family: ModelDto["family"];
    provider?: "anthropic" | "openai";
    base_url?: string;
    model?: string;
    api_key?: string;
  }) =>
    json<ModelDto>("/models", { method: "POST", body: JSON.stringify(body) }),

  updateModel: (id: string, body: Partial<{
    label: string;
    kind: ModelDto["kind"];
    family: ModelDto["family"];
    provider: "anthropic" | "openai";
    base_url: string;
    model: string;
    api_key: string;
  }>) =>
    json<ModelDto>(`/models/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  deleteModel: (id: string) =>
    json<{ ok: boolean }>(`/models/${encodeURIComponent(id)}`, { method: "DELETE" }),

  detectBinary: (kind: "claude-binary" | "codex-binary") =>
    json<{ found: boolean; path?: string; version?: string }>(
      `/models/detect?kind=${kind}`,
    ),

  updateRoles: (body: { roles: Record<string, string>; complexity_threshold: number }) =>
    json<{ ok: boolean }>("/models/roles", { method: "PUT", body: JSON.stringify(body) }),

  getRoles: () =>
    json<{ roles: Record<string, string>; complexity_threshold: number }>("/models/roles"),

  /** URL SSE-стрима для EventSource. */
  streamUrl: (key: string) =>
    `${API_URL}/processes/${encodeURIComponent(key)}/stream`,
};
