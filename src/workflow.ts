/**
 * Схема YAML-воркфлоу (PLAN §3.1) + поддержка циклов (loop).
 *
 * Воркфлоу = опциональные linear `steps` (DAG через depends_on) +
 * опциональный `loop` (тело из шагов, исполняется по кругам с условием
 * выхода по вердикту review-шага).
 */
import { z } from "zod";
import { posix } from "node:path";
import { getAgentFamily } from "./families.ts";
import { getRoleMap, getModels } from "./model-registry.ts";
import { logEvent } from "./blackboard.ts";
import type { AgentMetrics } from "./agent-metrics.ts";
import { scoreAgent } from "./agent-metrics.ts";
import type { Family } from "./model-config-dto.ts";
import type { Subtask } from "./plan.ts";

export const WorkflowStepSchema = z.object({
  /** Имя шага (уникально в воркфлоу). */
  id: z.string().min(1),
  /** Агент шага. Опционален только для fan_out-шагов (исполнитель определяется по подзадаче). */
  agent: z.string().optional(),
  role: z.enum(["plan", "implement", "review", "refine", "fix", "final", "architect"]),
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
  /** Если true — шаг раскрывается раннером в N (implement+review) по плану from_plan. */
  fan_out: z.boolean().default(false),
  /** id plan-шага, чей вывод парсится как SubtaskPlan. Обязательно при fan_out. */
  from_plan: z.string().min(1).optional(),
  /** Допустимые исполнители подзадач. Обязательно при fan_out. */
  agents: z.array(z.string()).optional(),
  /** Добавить codex(review) на каждую подзадачу. */
  review: z.boolean().default(false),
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
  // default 65: Claude оценивает сложность относительно всей задачи, поэтому
  // отдельным модулям достаётся 40-60. Порог 65 пускает в ollama только явный
  // boilerplate; всё сложнее (интеграция, тесты) забирает glm. Поднят с 50
  // после анализа провалов ollama (75% успеха против 94% у glm).
  complexity_threshold: z.number().int().min(0).max(100).default(65),
  max_parallel: z.number().int().positive().default(3),
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
)
// fan_out consistency
.refine(
  (w) => w.steps.every((s) => !s.fan_out || s.from_plan),
  { message: "fan_out steps require from_plan" },
)
.refine(
  (w) => {
    // Ревьюер для fan_out.review берётся из карты ролей (resolveRole("review"));
    // исполнитель не должен совпадать с ревьюером.
    const reviewer = getRoleMap().review;
    return w.steps.every((s) => !s.fan_out || !s.review || !reviewer || !s.agents || !s.agents.includes(reviewer));
  },
  { message: "fan_out with review cannot list the review-role model in agents (it is the reviewer)" },
)
// from_plan references an earlier step (declared before it)
.refine((w) => {
  const ids = w.steps.map((s) => s.id);
  for (const s of w.steps) {
    if (s.fan_out && s.from_plan) {
      const fi = ids.indexOf(s.from_plan);
      const si = ids.indexOf(s.id);
      if (fi === -1 || fi >= si) return false;
    }
  }
  return true;
}, { message: "fan_out.from_plan must reference an earlier step id" })
// review #5 (Codex): не-fan_out шаг обязан иметь agent (иначе тихо получает
// placeholder "claude" в resolveWorkflow — скрытая ошибка конфигурации).
.refine(
  (w) => w.steps.every((s) => s.fan_out || s.agent !== undefined),
  { message: "non-fan_out steps require an agent" },
)
// fan_out разрешён только в pre-loop steps (не в loop.steps / post_steps) —
// динамическое раскрытие внутри цикла/post не поддерживается (YAGNI).
.refine(
  (w) => w.loop === undefined || w.loop.steps.every((s) => !s.fan_out),
  { message: "fan_out is not allowed inside loop.steps (only in pre-loop steps)" },
)
.refine(
  (w) => w.post_steps.every((s) => !s.fan_out),
  { message: "fan_out is not allowed in post_steps (only in pre-loop steps)" },
)
// review #4 (review-2026-07-13): уникальность id в каждой секции.
.refine(
  (w) => {
    const sections = [w.steps, w.loop?.steps ?? [], w.post_steps];
    return sections.every((sec) => {
      const ids = sec.map((s) => s.id);
      return new Set(ids).size === ids.length;
    });
  },
  { message: "duplicate step id within a section (steps/loop.steps/post_steps)" },
)
// review #31 (review-2026-07-13): глобальная уникальность id по всем секциям.
// Раньше одинаковый id в steps и post_steps проходил проверку, из-за чего
// allSteps и поиск по id становились неоднозначными.
.refine(
  (w) => {
    const all = [...w.steps, ...(w.loop?.steps ?? []), ...w.post_steps].map((s) => s.id);
    return new Set(all).size === all.length;
  },
  { message: "duplicate step id across sections — step ids must be globally unique" },
)
// review #4: depends_on должно ссылаться на существующий id (в своей секции
// или в steps — для loop/post_steps, чтобы зависеть от pre-loop шагов).
.refine(
  (w) => {
    const allIds = new Set(w.steps.map((s) => s.id));
    // depends_on внутри steps ссылаются только на steps.
    const stepsOk = w.steps.every((s) => s.depends_on.every((dep) => allIds.has(dep)));
    if (!stepsOk) return false;
    // loop.steps / post_steps могут ссылаться на steps или свою секцию.
    const loopIds = new Set(w.loop?.steps.map((s) => s.id) ?? []);
    const postIds = new Set(w.post_steps.map((s) => s.id));
    const loopOk = (w.loop?.steps ?? []).every((s) => s.depends_on.every((dep) => allIds.has(dep) || loopIds.has(dep)));
    const postOk = w.post_steps.every((s) => s.depends_on.every((dep) => allIds.has(dep) || postIds.has(dep)));
    return loopOk && postOk;
  },
  { message: "depends_on references unknown step id (typo?) — all deps must exist" },
);
export type Workflow = z.infer<typeof WorkflowSchema>;

/** Дополненный шаг: family выводится из агента. agent всегда определён
 *  (для fan_out-шагов — плейсхолдер, реальный исполнитель ставится по подзадаче).
 *
 *  ВАЖНО: agent — строка (id модели из реестра). При fan-out маршрутизация
 *  подзадачи может выбрать local-модель (напр. ollama), и тогда раннер строит
 *  impl-шаг с этим agent. Для обычных шагов agent берётся из YAML или из
 *  глобальной карты ролей. */
export interface ResolvedStep extends Omit<WorkflowStep, "agent"> {
  agent: string;
  family: Family;
  agentName: string;
}

export function resolveWorkflow(steps: WorkflowStep[]): ResolvedStep[] {
  const roleMap = getRoleMap();
  return steps.map((s) => {
    // Приоритет: per-step agent (YAML) > глобальная карта ролей из реестра > плейсхолдер "claude".
    // Это сохраняет обратную совместимость: существующие workflows/*.yaml с явным
    // agent: продолжают работать, а шаги без agent получают модель по роли из Settings.
    const agent: string = s.agent ?? roleMap[s.role] ?? "claude";
    const family = getAgentFamily(agent);
    if (!family && !s.fan_out) {
      throw new Error(
        `resolveWorkflow: model '${agent}' not found (step '${s.id}', role '${s.role}'). ` +
          `Add it in Settings or set agent explicitly.`,
      );
    }
    return { ...s, agent, agentName: agent, family: family ?? "anthropic" };
  });
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
      // review #4 (review-2026-07-13): неизвестная зависимость (опечатка) ловится
      // schema-валидатором. Но topoLevels вызывается на подмножестве шагов
      // (prePlain / postFanOutPlain) — зависимость на fan_out-шаг или шаг из
      // другой секции валидна, но этого шага нет в текущем наборе. Считаем её
      // выполненной (она отрабатывает в другой фазе раннера).
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

/**
 * Проверить, что target_paths шагов в одном уровне не пересекаются (§4.5.2).
 * review #30 (review-2026-07-13): используем pathsOverlap (видит parent/child),
 * а не точный includes — иначе шаги с `paths:[src]` и `paths:[src/x.ts]`
 * ошибочно проходят проверку и могут одновременно менять одни файлы.
 */
export function assertNonOverlappingPaths(level: ResolvedStep[]): void {
  for (let i = 0; i < level.length; i++) {
    for (let j = i + 1; j < level.length; j++) {
      const a = level[i]!;
      const b = level[j]!;
      if (pathsOverlap(a.target_paths, b.target_paths)) {
        throw new Error(
          `Steps ${a.id} and ${b.id} in same level have overlapping target_paths ` +
            `([${a.target_paths.join(", ")}] vs [${b.target_paths.join(", ")}]). ` +
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
  // fan_out-шаги не считаются автором для статической cross-family проверки:
  // они раскрываются в подзадачи со смесью семей, кросс-семейность проверяется
  // динамически по подзадаче (Task 10).
  const isRealAuthor = (s: ResolvedStep | undefined): s is ResolvedStep =>
    !!s && !s.fan_out && implementRoles.has(s.role);
  for (const dep of review.depends_on) {
    const s = all.find((x) => x.id === dep);
    if (isRealAuthor(s)) return s;
  }
  const reviewIdx = all.findIndex((x) => x.id === review.id);
  for (let i = reviewIdx - 1; i >= 0; i--) {
    const s = all[i];
    if (isRealAuthor(s)) return s;
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
      // review #4: зависимость на шаг вне этого подмножества — валидна,
      // выполняется в другой фазе. Опечатки ловит schema-валидатор.
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

/**
 * Нормализовать путь для сравнения target_paths (review #11).
 * backslash→slash (Windows-пути в YAML), затем posix.normalize коллапсит
 * ./, // и ../ (a/b/../c → a/c). Старый regex-only norm не видел ../,
 * из-за чего pathsOverlap пропускал реальное пересечение.
 */
function norm(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  const normalized = posix.normalize(slashed);
  // normalize оставляет trailing /. для пустого/корня — убираем.
  return normalized.replace(/\/$/, "") || normalized;
}

/** Пересекаются ли две области target_paths? parent/child считается пересечением. */
export function pathsOverlap(a: string[], b: string[]): boolean {
  const na = a.map(norm);
  const nb = b.map(norm);
  for (const x of na) for (const y of nb) {
    if (x === y) return true;
    if (x.startsWith(y + "/") || y.startsWith(x + "/")) return true; // parent/child
  }
  return false;
}

/** Маршрутизация подзадачи: complexity >= threshold → strong, иначе local. Берёт первого подходящего из agents. */
export function routeSubtask(subtask: Subtask, agents: string[], threshold: number): string {
  const strong = subtask.complexity >= threshold;
  for (const a of agents) {
    const fam = getAgentFamily(a);
    if (!fam) throw new Error(`routeSubtask: unknown model ${a}`);
    if (strong && fam !== "local") return a;
    if (!strong && fam === "local") return a;
  }
  throw new Error(`routeSubtask: no agent for subtask ${subtask.id} (complexity ${subtask.complexity}, threshold ${threshold}, side=${strong ? "strong" : "local"}) in agents [${agents.join(",")}]`);
}

/**
 * Метрики-aware маршрутизация (T3). Та же семантика, что у routeSubtask —
 * threshold/complexity определяет сторону (strong vs local family), — но среди
 * кандидатов нужной стороны выбирается агент с **минимальным score** (ниже = лучше:
 * меньше error-rate, при равенстве — меньше latency).
 *
 * В отличие от routeSubtask (first-match), эта функция скорит всех кандидатов
 * стороны и берёт лучшего. Решение логируется (kind: "route_decision") для
 * воспроизводимости — видно в отчёте T2, почему выбран агент.
 *
 * @param logCtx taskId + root для logEvent. Если undefined — логирование отключено (тесты).
 */
export async function routeSubtaskWithMetrics(
  subtask: Subtask,
  agents: string[],
  threshold: number,
  metrics: AgentMetrics,
  logCtx?: { taskId: string; root: string },
): Promise<string> {
  const strong = subtask.complexity >= threshold;
  // Тот же базовый фильтр по стороне — семантика порога сохранена.
  const candidates: string[] = [];
  for (const a of agents) {
    const fam = getAgentFamily(a);
    if (!fam) throw new Error(`routeSubtaskWithMetrics: unknown model ${a}`);
    if (strong && fam !== "local") candidates.push(a);
    if (!strong && fam === "local") candidates.push(a);
  }
  if (candidates.length === 0) {
    throw new Error(`routeSubtaskWithMetrics: no agent for subtask ${subtask.id} (complexity ${subtask.complexity}, threshold ${threshold}, side=${strong ? "strong" : "local"}) in agents [${agents.join(",")}]`);
  }
  // Один кандидат — без метрик (нечего выбирать).
  if (candidates.length === 1) {
    const chosen = candidates[0]!;
    await logRouteDecision(logCtx, subtask.id, strong ? "strong" : "local", candidates, metrics, chosen);
    return chosen;
  }
  // Несколько кандидатов — скорим, выбираем минимальный score.
  let best = candidates[0]!;
  let bestScore = scoreAgent(metrics.stats.get(best));
  for (let i = 1; i < candidates.length; i++) {
    const cand = candidates[i]!;
    const score = scoreAgent(metrics.stats.get(cand));
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  await logRouteDecision(logCtx, subtask.id, strong ? "strong" : "local", candidates, metrics, best);
  return best;
}

/** Записать route_decision в log (для воспроизводимости и отчёта T2). */
async function logRouteDecision(
  logCtx: { taskId: string; root: string } | undefined,
  subtaskId: string,
  side: string,
  candidates: string[],
  metrics: AgentMetrics,
  chosen: string,
): Promise<void> {
  if (!logCtx) return;
  try {
    await logEvent({
      task_id: logCtx.taskId,
      step_id: null,
      level: "info",
      kind: "route_decision",
      message: `routed subtask ${subtaskId} (${side}) → ${chosen}`,
      data: {
        subtask: subtaskId,
        side,
        candidates: candidates.map((a) => ({ agent: a, score: scoreAgent(metrics.stats.get(a)) })),
        chosen,
      },
    }, logCtx.root);
  } catch {
    // логирование — best-effort, не валить маршрутизацию
  }
}

/** Раскрытие fan_out-шага: откуда брать план, кто исполняет, нужен ли codex-ревью. */
export interface FanOutSpec {
  step: ResolvedStep;
  fromPlanId: string;
  agents: string[];
  review: boolean;
}

/** Результат loadWorkflow — всё, что нужно раннеру для исполнения. */
export interface LoadedWorkflow {
  wf: Workflow;
  /** Линейные шаги ДО цикла и ДО fan-out (DAG → уровни). fan_out-шаги сюда не входят,
   *  как и шаги, транзитивно зависящие от fan_out-шага (они — в postFanOutLevels). */
  preLevels: ResolvedStep[][];
  /** Шаги, транзитивно зависящие от fan_out-шага (напр. final с depends_on:[build]).
   *  Исполняются ПОСЛЕ fan-out. Пусто, если fan_out нет или за ним ничего не стоит. */
  postFanOutLevels: ResolvedStep[][];
  /** Тело цикла (последовательный порядок). Пусто, если loop нет. */
  loopBody: ResolvedStep[];
  /** Конфиг цикла, если есть. */
  loop: Loop | undefined;
  /** Линейные шаги ПОСЛЕ цикла (DAG → уровни). Пусто, если loop нет. */
  postLevels: ResolvedStep[][];
  /** Все шаги (pre + postFanOut + loop + post) — для contextFromPrevStep и stepIdx. */
  allSteps: ResolvedStep[];
  /** Раскрытия fan_out-шагов (раннер раскрывает по плану из fromPlanId, Task 10). */
  fanOuts: FanOutSpec[];
}

/**
 * Найти все id шагов, которые транзитивно зависят от любого из `roots` (по depends_on).
 * Используется для разбиения plain-шагов вокруг fan_out: шаги, зависящие от fan_out-шага,
 * должны исполниться ПОСЛЕ fan-out (напр. final с depends_on:[build]).
 *
 * `allIds` — полный набор id (включая fan_out-шаги), по которым раскручиваем зависимости.
 */
function transitiveDependents(
  steps: { id: string; depends_on: string[] }[],
  roots: Set<string>,
): Set<string> {
  // Обратный граф: для каждого шага — кто на него ссылается в depends_on.
  const reverse = new Map<string, Set<string>>();
  for (const s of steps) {
    for (const dep of s.depends_on) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep)!.add(s.id);
    }
  }
  const result = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const dependents = reverse.get(cur);
    if (!dependents) continue;
    for (const d of dependents) {
      if (!result.has(d)) {
        result.add(d);
        queue.push(d);
      }
    }
  }
  return result;
}

/**
 * Загрузить и провалидировать воркфлоу из YAML: парсинг, resolve, валидации.
 * Возвращает структуру для раннера. fan_out-шаги исключаются из preLevels
 * и регистрируются отдельно в fanOuts.
 */
export function buildLoadedWorkflow(wf: Workflow): LoadedWorkflow {
  const allPre = resolveWorkflow(wf.steps);
  assertCrossFamilyReview(allPre);

  // Разделить: обычные шаги идут в preLevels/postFanOutLevels, fan_out-шаги — в fanOuts.
  const plainSteps = allPre.filter((s) => !s.fan_out);
  const fanOutSteps = allPre.filter((s) => s.fan_out);

  const fanOuts: FanOutSpec[] = fanOutSteps.map((s) => {
    // review fan-out #workflow-roles: agents могут быть не заданы в YAML —
    // тогда берём всех non-architect моделей из реестра (кроме review-роли),
    // чтобы routeSubtask сам выбрал strong/local по threshold.
    let agents = s.agents;
    if (!agents || agents.length === 0) {
      const roleMap = getRoleMap();
      const reviewer = roleMap.review;
      agents = getModels()
        .filter((m) => m.id !== reviewer)
        .map((m) => m.id);
      if (agents.length === 0) {
        throw new Error(
          `fan_out step '${s.id}': no agents specified and registry has no candidates. ` +
          `Set 'agents' in YAML or add models in Settings.`,
        );
      }
    }
    return {
      step: s,
      fromPlanId: s.from_plan!,
      agents,
      review: s.review,
    };
  });
  if (fanOuts.length > 1) {
    throw new Error("Only one fan_out step per workflow is supported (YAGNI)");
  }

  // Разбить plain-шаги вокруг fan_out: шаги, транзитивно зависящие от fan_out-шага
  // (напр. final с depends_on:[build]), исполняются ПОСЛЕ fan-out. Остальные — до.
  // allPre включается целиком (с fan_out-шагами), чтобы transitiveDependents видел
  // зависимости через id fan_out-шага (build). reverse-граф строится по depends_on.
  let prePlain = plainSteps;
  let postFanOutPlain: ResolvedStep[] = [];
  if (fanOutSteps.length > 0) {
    const fanOutIds = new Set(fanOutSteps.map((s) => s.id));
    const afterIds = transitiveDependents(
      allPre.map((s) => ({ id: s.id, depends_on: s.depends_on })),
      fanOutIds,
    );
    prePlain = plainSteps.filter((s) => !afterIds.has(s.id));
    postFanOutPlain = plainSteps.filter((s) => afterIds.has(s.id));
  }

  const preLevels = topoLevels(prePlain);
  for (const level of preLevels) assertNonOverlappingPaths(level);
  const postFanOutLevels = topoLevels(postFanOutPlain);
  for (const level of postFanOutLevels) assertNonOverlappingPaths(level);

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
  const allSteps = [...allPre, ...loopBody, ...postSteps];
  return { wf, preLevels, postFanOutLevels, loopBody, loop, postLevels, allSteps, fanOuts };
}
