/**
 * Схема YAML-воркфлоу (PLAN §3.1) + поддержка циклов (loop).
 *
 * Воркфлоу = опциональные linear `steps` (DAG через depends_on) +
 * опциональный `loop` (тело из шагов, исполняется по кругам с условием
 * выхода по вердикту review-шага).
 */
import { z } from "zod";
import { AGENTS, type AgentName, type Family } from "./families.ts";

export const WorkflowStepSchema = z.object({
  /** Имя шага (уникально в воркфлоу). */
  id: z.string().min(1),
  agent: z.enum(["claude", "codex", "glm"]),
  role: z.enum(["plan", "implement", "review", "refine", "fix", "final"]),
  effort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  budget: z.object({
    wall_time_sec: z.number().int().positive(),
    max_steps: z.number().int().positive(),
    max_session_min: z.number().int().positive().max(25).optional(),
  }),
  /** Имена шагов, от которых зависит (выполняются раньше). Вне loop — DAG.
   *  Внутри loop.steps — могут ссылаться на шаги того же тела (исполняются в порядке по кругам). */
  depends_on: z.array(z.string()).default([]),
  /** Ограничение области работы (для worktree). */
  target_paths: z.array(z.string()).default([]),
  /** Явное разрешение review той же семьёй (§3.4). */
  allow_same_family: z.boolean().default(false),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/** Конфигурация цикла. */
export const LoopSchema = z.object({
  /** Шаги тела цикла (исполняются последовательно каждый круг, по depends_on внутри тела). */
  steps: z.array(WorkflowStepSchema).min(1),
  /** id шага, чей вердикт проверяем (обычно review). Должен быть в steps. */
  exit_on: z.string().min(1),
  /** Лимит кругов (по умолчанию 3). */
  max_iterations: z.number().int().positive().default(3),
  /** Что делать, если лимит исчерпан без APPROVE: hitl (по умолчанию) | accept. */
  on_exhausted: z.enum(["hitl", "accept"]).default("hitl"),
});
export type Loop = z.infer<typeof LoopSchema>;

export const WorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** Линейные шаги ДО цикла (DAG). Могут быть пустым массивом. */
  steps: z.array(WorkflowStepSchema).default([]),
  /** Опциональный цикл. Если есть — исполняется после `steps`. */
  loop: LoopSchema.optional(),
  /** Линейные шаги ПОСЛЕ цикла (DAG). Исполняются после выхода из loop.
   *  Имеют смысл только при наличии loop (иначе это просто steps). */
  post_steps: z.array(WorkflowStepSchema).default([]),
}).refine(
  (w) => w.steps.length > 0 || w.loop !== undefined || w.post_steps.length > 0,
  { message: "Workflow must have steps, loop, or post_steps" },
).refine(
  (w) => w.post_steps.length === 0 || w.loop !== undefined,
  { message: "post_steps require a loop (otherwise use steps)" },
);
export type Workflow = z.infer<typeof WorkflowSchema>;

/** Дополненный шаг: family выводится из агента. */
export interface ResolvedStep extends WorkflowStep {
  family: Family;
  agentName: AgentName;
}

export function resolveWorkflow(steps: WorkflowStep[]): ResolvedStep[] {
  return steps.map((s) => ({
    ...s,
    agentName: s.agent as AgentName,
    family: AGENTS[s.agent as AgentName].family,
  }));
}

/**
 * Топологическая сортировка шагов по depends_on.
 * Возвращает уровни: каждый уровень — шаги, которые можно исполнять параллельно.
 * Бросает ошибку при цикле в depends_on.
 */
export function topoLevels(steps: ResolvedStep[]): ResolvedStep[][] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const levels: ResolvedStep[][] = [];

  while (done.size < steps.length) {
    const level = steps.filter((s) => {
      if (done.has(s.id)) return false;
      return s.depends_on.every((dep) => done.has(dep) || !byId.has(dep));
    });
    if (level.length === 0) {
      throw new Error(`Workflow has cyclic dependency among: ${steps.filter((s) => !done.has(s.id)).map((s) => s.id).join(", ")}`);
    }
    levels.push(level);
    for (const s of level) done.add(s.id);
  }
  return levels;
}

/** Проверить, что target_paths шагов в одном уровне не пересекаются (§4.5.2). */
export function assertNonOverlappingPaths(level: ResolvedStep[]): void {
  for (let i = 0; i < level.length; i++) {
    for (let j = i + 1; j < level.length; j++) {
      const a = level[i]!;
      const b = level[j]!;
      const overlap = a.target_paths.filter((p) => b.target_paths.includes(p));
      if (overlap.length > 0) {
        throw new Error(
          `Steps ${a.id} and ${b.id} in same level have overlapping target_paths: ${overlap.join(", ")}. ` +
            `Make them sequential (depends_on) or split paths.`,
        );
      }
    }
  }
}

/**
 * Кросс-семейная валидация review/final шагов (PLAN §3.4).
 * Ревьюер должен быть из семьи, отличной от автора кода на предыдущем implement-шаге.
 */
export function assertCrossFamilyReview(steps: ResolvedStep[]): void {
  for (const step of steps) {
    if (step.role !== "review" && step.role !== "final") continue;
    if (step.allow_same_family) continue;
    const author = findAuthor(step, steps);
    if (!author) continue;
    if (author.family === step.family) {
      throw new Error(
        `Cross-family violation: step '${step.id}' (role=${step.role}, family=${step.family}) ` +
          `reviews '${author.id}' (family=${author.family}) — same family. ` +
          `Set allow_same_family: true on '${step.id}' or change its agent.`,
      );
    }
  }
}

function findAuthor(review: ResolvedStep, all: ResolvedStep[]): ResolvedStep | null {
  const implementRoles = new Set(["implement", "refine", "fix"]);
  for (const dep of review.depends_on) {
    const s = all.find((x) => x.id === dep);
    if (s && implementRoles.has(s.role)) return s;
  }
  const reviewIdx = all.findIndex((x) => x.id === review.id);
  for (let i = reviewIdx - 1; i >= 0; i--) {
    const s = all[i];
    if (s && implementRoles.has(s.role)) return s;
  }
  return null;
}

/**
 * Стабильный порядок шагов тела цикла (по depends_on внутри тела).
 * В отличие от topoLevels — возвращает плоский список (тело исполняется
 * последовательно, не параллельно). Бросает при цикле.
 */
export function orderLoopBody(steps: ResolvedStep[]): ResolvedStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const ordered: ResolvedStep[] = [];

  while (done.size < steps.length) {
    const ready = steps.filter((s) => {
      if (done.has(s.id)) return false;
      return s.depends_on.every((dep) => done.has(dep) || !byId.has(dep));
    });
    if (ready.length === 0) {
      throw new Error(`Loop has cyclic dependency among: ${steps.filter((s) => !done.has(s.id)).map((s) => s.id).join(", ")}`);
    }
    // Берём первый готовый (тело — последовательное).
    const next = ready[0]!;
    ordered.push(next);
    done.add(next.id);
  }
  return ordered;
}

/** Результат loadWorkflow — всё, что нужно раннеру для исполнения. */
export interface LoadedWorkflow {
  wf: Workflow;
  /** Линейные шаги ДО цикла (DAG → уровни). */
  preLevels: ResolvedStep[][];
  /** Тело цикла (последовательный порядок). Пусто, если loop нет. */
  loopBody: ResolvedStep[];
  /** Конфиг цикла, если есть. */
  loop: Loop | undefined;
  /** Линейные шаги ПОСЛЕ цикла (DAG → уровни). Пусто, если loop нет. */
  postLevels: ResolvedStep[][];
  /** Все шаги (pre + loop + post) — для contextFromPrevStep и stepIdx. */
  allSteps: ResolvedStep[];
}

/**
 * Загрузить и провалидировать воркфлоу из YAML: парсинг, resolve, валидации.
 * Возвращает структуру для раннера.
 */
export function buildLoadedWorkflow(wf: Workflow): LoadedWorkflow {
  const preSteps = resolveWorkflow(wf.steps);
  // Валидации для линейной части (pre).
  assertCrossFamilyReview(preSteps);
  const preLevels = topoLevels(preSteps);
  for (const level of preLevels) assertNonOverlappingPaths(level);

  let loopBody: ResolvedStep[] = [];
  let loop: Loop | undefined;
  if (wf.loop) {
    loop = wf.loop;
    const loopSteps = resolveWorkflow(loop.steps);
    // exit_on должен быть в теле и иметь роль review или final.
    const exitStep = loopSteps.find((s) => s.id === loop!.exit_on);
    if (!exitStep) {
      throw new Error(`loop.exit_on='${loop.exit_on}' not found in loop.steps`);
    }
    if (exitStep.role !== "review" && exitStep.role !== "final") {
      throw new Error(
        `loop.exit_on='${loop.exit_on}' must be role review or final (got ${exitStep.role}), ` +
          `otherwise there is no verdict to exit on.`,
      );
    }
    // Кросс-семейная валидация для тела цикла (каждый круг — те же правила).
    assertCrossFamilyReview(loopSteps);
    loopBody = orderLoopBody(loopSteps);
  }

  // post_steps — после цикла.
  const postSteps = resolveWorkflow(wf.post_steps);
  assertCrossFamilyReview(postSteps);
  const postLevels = topoLevels(postSteps);
  for (const level of postLevels) assertNonOverlappingPaths(level);

  // allSteps = pre + loop + post (для stepIdx/context). stepIdx сквозной.
  const allSteps = [...preSteps, ...loopBody, ...postSteps];
  return { wf, preLevels, loopBody, loop, postLevels, allSteps };
}
