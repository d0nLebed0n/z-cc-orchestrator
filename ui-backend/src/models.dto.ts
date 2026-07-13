/**
 * DTO и zod-схемы для создания/редактирования модели и ролей (T1-T5 review #7).
 *
 * Discriminated union по `kind`: для каждого вида модели — свой набор
 * обязательных полей. Иначе через UI/API можно создать модель, которая сразу
 * упадёт с base_url/api_key missing.
 */
import { z } from "zod";

export const MODEL_KINDS = ["claude-binary", "codex-binary", "ollama-http", "api"] as const;
export const MODEL_FAMILIES = ["anthropic", "openai", "zai", "local"] as const;
export const API_PROVIDERS = ["anthropic", "openai"] as const;

/**
 * Роли, которые можно назначить в карте ролей.
 * Дублируется из src/envelope.ts RoleSchema (backend намеренно развязан от core-TS,
 * см. комментарий в types.ts). Включая architect — для --init-project workflow.
 */
export const ROLE_NAMES = [
  "plan",
  "implement",
  "review",
  "refine",
  "fix",
  "final",
  "architect",
] as const;

const idField = z
  .string()
  .min(1, "id is required")
  .regex(/^[a-zA-Z0-9_-]+$/, "id must be alphanumeric (letters, digits, _ or -)");
const labelField = z.string().min(1, "label is required");
const familyField = z.enum(MODEL_FAMILIES);
const apiKeyField = z.string().min(1).optional();

/**
 * Discriminated union по kind (review #7 T1-T5):
 *  - claude-binary / codex-binary: НЕ принимают provider/base_url/model/api_key.
 *  - ollama-http: base_url + model обязательны; provider/api_key запрещены.
 *  - api: provider + base_url + api_key обязательны; model опционален.
 */
const baseCreateFields = {
  id: idField,
  label: labelField,
  family: familyField,
};

const binaryModelSchema = z.object({
  ...baseCreateFields,
  kind: z.literal("claude-binary"),
}).strict();

const codexModelSchema = z.object({
  ...baseCreateFields,
  kind: z.literal("codex-binary"),
}).strict();

const ollamaModelSchema = z.object({
  ...baseCreateFields,
  kind: z.literal("ollama-http"),
  base_url: z.string().url("base_url is required for ollama-http"),
  model: z.string().min(1, "model is required for ollama-http"),
}).strict();

const apiModelSchema = z.object({
  ...baseCreateFields,
  kind: z.literal("api"),
  provider: z.enum(API_PROVIDERS, { message: "provider required for kind=api" }),
  base_url: z.string().url("base_url is required for kind=api"),
  model: z.string().optional(),
  /** API-ключ — только при создании/редактировании kind=api. Не возвращается в GET. */
  api_key: z.string().min(1, "api_key is required for kind=api"),
}).strict();

export const modelInputSchema = z.discriminatedUnion("kind", [
  binaryModelSchema,
  codexModelSchema,
  ollamaModelSchema,
  apiModelSchema,
]);

export type ModelInputDto = z.infer<typeof modelInputSchema>;

/**
 * Частичная схема для PUT (update).
 * review #8 (T1-T5): `id` НЕ входит в update — переименование запрещено
 * (иначе дубликаты + висящие role references). Менять id можно только через
 * delete + create.
 */
export const modelUpdateSchema = z.object({
  label: z.string().min(1).optional(),
  family: familyField.optional(),
  base_url: z.string().url().optional(),
  model: z.string().optional(),
  api_key: z.string().min(1).optional(),
}).strict();
export type ModelUpdateDto = z.infer<typeof modelUpdateSchema>;

/**
 * Схема карты ролей. Роли → model id; threshold — целое 0..100.
 * Связность role→model проверяется в сервисе (нужен список существующих id).
 */
export const updateRolesSchema = z.object({
  roles: z.record(z.enum(ROLE_NAMES), z.string().min(1)),
  complexity_threshold: z.number().int().min(0).max(100),
});

export type UpdateRolesDto = z.infer<typeof updateRolesSchema>;
