/**
 * Task-envelope — единый JSON-формат задачи от раннера воркеру (PLAN §2.4).
 *
 * Раннер формирует envelope для каждого шага, валидирует через zod,
 * отдаёт воркеру. Контекст предыдущего шага (review/plan/checkpoint)
 * подставляется в поле `context`.
 */
import { z } from "zod";
import { AGENTS, type AgentName, type Family } from "./families.ts";

export const RoleSchema = z.enum([
  "plan",
  "implement",
  "review",
  "refine",
  "fix",
  "final",
]);
export type Role = z.infer<typeof RoleSchema>;

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type Effort = z.infer<typeof EffortSchema>;

export const BudgetSchema = z.object({
  /** Общий таймбокс шага, сек. Превышение → шаг прерывается раннером. */
  wall_time_sec: z.number().int().positive(),
  /** Лимит диспатчей/ретраев одного шага (не шагов в воркфлоу!). */
  max_steps: z.number().int().positive(),
  /** Только для codex: лимит одной сессии ≤ 25 мин (PLAN §5). */
  max_session_min: z.number().int().positive().max(25).optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const TaskEnvelopeSchema = z.object({
  id: z.string().min(1),
  agent: z.enum(["claude", "codex", "glm", "ollama"]),
  family: z.enum(["anthropic", "openai", "zai", "local"]),
  role: RoleSchema,
  prompt: z.string().min(1),
  /** Ограничивает область работы воркера (для worktree/targeting). */
  target_paths: z.array(z.string()).default([]),
  /**
   * Вывод предыдущего шага, подставляемый раннером:
   *   digest checkpoint (после обрыва, §4.3)
   *   | замечания review (→ fix)
   *   | план подзадач (plan → implement)
   *   | null для первого шага.
   */
  context: z.string().nullable().default(null),
  budget: BudgetSchema,
  effort: EffortSchema.default("medium"),
  /** Если true — раннер не проверяет кросс-семейность review (явное исключение). */
  allow_same_family: z.boolean().default(false),
});
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

/** Согласованность: family в envelope должна совпадать с family агента. */
export function validateEnvelope(e: TaskEnvelope): void {
  const expectedFamily: Family = AGENTS[e.agent as AgentName].family;
  if (e.family !== expectedFamily) {
    throw new Error(
      `Envelope family mismatch: agent='${e.agent}' implies family='${expectedFamily}', ` +
        `but envelope says family='${e.family}'.`,
    );
  }
}

/** Создать envelope с автоматическим выводом family из агента. */
export function makeEnvelope(
  input: Omit<TaskEnvelope, "family" | "allow_same_family"> &
    Partial<Pick<TaskEnvelope, "family" | "allow_same_family">>,
): TaskEnvelope {
  const agent = input.agent as AgentName;
  const family: Family = input.family ?? AGENTS[agent].family;
  const e: TaskEnvelope = TaskEnvelopeSchema.parse({
    ...input,
    family,
    allow_same_family: input.allow_same_family ?? false,
  });
  validateEnvelope(e);
  return e;
}
