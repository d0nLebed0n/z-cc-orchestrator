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

/**
 * Одна модель в каталоге.
 *
 * review #38 (review-2026-07-13): discriminated union по kind, согласованный с
 * backend create-schema (models.dto.ts). Раньше это был один широкий объект с
 * optional provider/base_url/model — API-запись без base_url и ollama без model
 * проходили safeParse, и ошибка обнаруживалась только в health/runtime.
 *
 * binary-модели не принимают сетевых полей; ollama-http требует base_url+model;
 * api требует base_url+provider (model опционален, api_key живёт в .secrets).
 */
const binaryModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.literal("claude-binary"),
  family: FamilySchema,
  provider: z.undefined(),
  base_url: z.undefined(),
  model: z.undefined(),
});
const codexModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.literal("codex-binary"),
  family: FamilySchema,
  provider: z.undefined(),
  base_url: z.undefined(),
  model: z.undefined(),
});
const ollamaModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.literal("ollama-http"),
  family: FamilySchema,
  provider: z.undefined(),
  base_url: z.string().min(1, "base_url required for ollama-http"),
  model: z.string().min(1, "model required for ollama-http"),
});
const apiModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.literal("api"),
  family: FamilySchema,
  provider: z.enum(["anthropic", "openai"]),
  base_url: z.string().min(1, "base_url required for api"),
  model: z.string().optional(),
});

export const ModelInfoSchema = z.discriminatedUnion("kind", [
  binaryModelInfoSchema,
  codexModelInfoSchema,
  ollamaModelInfoSchema,
  apiModelInfoSchema,
]);
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
