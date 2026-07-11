/** DTO для создания/редактирования модели. */
export interface ModelInputDto {
  id: string;
  label: string;
  kind: "claude-binary" | "codex-binary" | "ollama-http" | "api";
  family: "anthropic" | "openai" | "zai" | "local";
  provider?: "anthropic" | "openai";
  base_url?: string;
  model?: string;
  /** API-ключ — только при создании/редактировании kind=api. Не возвращается в GET. */
  api_key?: string;
}

/** DTO для обновления карты ролей. */
export interface UpdateRolesDto {
  roles: Record<string, string>;
  complexity_threshold: number;
}
