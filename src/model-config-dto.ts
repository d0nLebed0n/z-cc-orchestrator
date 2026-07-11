import { z } from "zod";
import { RoleSchema } from "./envelope.ts";

/** Способ запуска модели. */
export const ModelKindSchema = z.enum([
  "claude-binary",
  "codex-binary",
  "ollama-http",
  "api",
]);
export type ModelKind = z.infer<typeof ModelKindSchema>;

/** Семья модели — семантическое понятие для cross-family review rules. */
export const FamilySchema = z.enum(["anthropic", "openai", "zai", "local"]);
export type Family = z.infer<typeof FamilySchema>;

/** Одна модель в каталоге. */
export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: ModelKindSchema,
  family: FamilySchema,
  /** Только для kind=api: формат совместимости эндпоинта. */
  provider: z.enum(["anthropic", "openai"]).optional(),
  /** Для kind=api | ollama-http. */
  base_url: z.string().optional(),
  /** Для kind=ollama-http: имя модели на сервере. */
  model: z.string().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** Роль → id модели. Все 6 ролей обязательны для валидного конфига. */
export const RoleMapSchema = z.record(RoleSchema, z.string().min(1));
export type RoleMap = z.infer<typeof RoleMapSchema>;

/** Полный конфиг в models.yaml. */
export const ModelsConfigSchema = z.object({
  models: z.array(ModelInfoSchema).min(1),
  roles: RoleMapSchema,
  complexity_threshold: z.number().int().min(0).max(100),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
