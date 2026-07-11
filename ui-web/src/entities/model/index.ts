export type Family = "anthropic" | "openai" | "zai" | "local";
export type ModelKind = "claude-binary" | "codex-binary" | "ollama-http" | "api";
export type Role = "plan" | "implement" | "review" | "refine" | "fix" | "final";
export type RoleMap = Partial<Record<Role, string>>;

export interface ModelDto {
  id: string;
  label: string;
  kind: ModelKind;
  family: Family;
  provider?: "anthropic" | "openai";
  base_url?: string;
  model?: string;
  status: "ready" | "not_found" | "unknown";
}

export const ROLE_LABELS: Record<Role, string> = {
  plan: "План",
  implement: "Имплементация",
  review: "Ревью",
  refine: "Доработка",
  fix: "Фикс",
  final: "Финал",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  plan: "Декомпозиция задачи в план подзадач",
  implement: "Написание кода по плану/задаче",
  review: "Кросс-семейное ревью изменений",
  refine: "Доработка по замечаниям ревью",
  fix: "Исправление ошибок",
  final: "Финальная проверка/сборка",
};

export const KIND_LABELS: Record<ModelKind, string> = {
  "claude-binary": "Claude (локальный)",
  "codex-binary": "Codex (локальный)",
  "ollama-http": "Ollama (Tailscale/HTTP)",
  api: "API (эндпоинт)",
};

export const FAMILY_LABELS: Record<Family, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  zai: "Z.ai",
  local: "Локальная",
};
