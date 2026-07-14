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
// review #49 (review-2026-07-13): для provider=openai поле `model` обязательно —
// dispatchWorker бросает без него, а statusOf показывал бы `ready`. Для
// provider=anthropic model опциональна. Здесь модель остаётся optional;
// cross-field-проверка (provider=openai ⇒ model) выполняется в ModelsConfigSchema
// superRefine ниже (zod discriminatedUnion требует ZodObject-опции, без вложенных
// refine/union).
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

/** Роль → id модели. Все 7 ролей обязательны для валидного конфига. */
export const RoleMapSchema = z.record(RoleSchema, z.string().min(1));
export type RoleMap = z.infer<typeof RoleMapSchema>;

/**
 * Полный конфиг в models.yaml.
 *
 * review #51 (review-2026-07-13): superRefine проверяет целостность каталога,
 * которую discriminatedUnion по kind не покрывает: уникальные model ids, полный
 * обязательный набор roles и существование каждой role→model. Раньше schema
 * принимала дубли ids, неполную карту ролей и dangling references.
 *
 * review #49: заодно проверяем provider=openai ⇒ model обязательно.
 */
export const ModelsConfigSchema = z
  .object({
    models: z.array(ModelInfoSchema).min(1),
    roles: RoleMapSchema,
    complexity_threshold: z.number().int().min(0).max(100),
  })
  .superRefine((cfg, ctx) => {
    // Уникальные model ids.
    const ids = new Set<string>();
    const seenDup = new Set<string>();
    for (const m of cfg.models) {
      if (ids.has(m.id)) seenDup.add(m.id);
      ids.add(m.id);
    }
    if (seenDup.size > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate model id(s): ${[...seenDup].join(", ")}`,
        path: ["models"],
      });
    }
    // Все обязательные роли присутствуют.
    const requiredRoles: string[] = ["plan", "implement", "review", "refine", "fix", "final", "architect"];
    const missing = requiredRoles.filter((r) => !(r in cfg.roles));
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `missing required role(s): ${missing.join(", ")}`,
        path: ["roles"],
      });
    }
    // Каждая role ссылается на существующую модель (dangling references).
    for (const [role, mid] of Object.entries(cfg.roles)) {
      if (!ids.has(mid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `role '${role}' references unknown model '${mid}'`,
          path: ["roles", role],
        });
      }
    }
    // review #49: provider=openai ⇒ model обязательно.
    for (const m of cfg.models) {
      if (m.kind === "api" && m.provider === "openai" && !m.model) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `model '${m.id}': model is required for provider=openai`,
          path: ["models"],
        });
      }
    }
  });
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
