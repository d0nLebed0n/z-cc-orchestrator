/**
 * Раннер — ОРКЕСТРАТОР (PLAN §0, §3.3).
 *
 * Ядро системы: парсит YAML → строит граф шагов → для каждого шага формирует
 * envelope → запускает воркера → проверяет сигналы успеха → пишет результат в
 * blackboard → следующий шаг. Владеет бюджетом и циклом целиком.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  WorkflowSchema,
  buildLoadedWorkflow,
  routeSubtask,
  pathsOverlap,
  type ResolvedStep,
  type LoadedWorkflow,
  type FanOutSpec,
} from "./workflow.ts";
import { AGENTS, type AgentName } from "./families.ts";
import { parsePlan, type Subtask, type SubtaskPlan } from "./plan.ts";
import { makeEnvelope, type TaskEnvelope } from "./envelope.ts";
import { getWorker, type WorkerResult, type WorkerRunOptions } from "./workers/index.ts";
import {
  createTask,
  updateTask,
  upsertStep,
  writeResult,
  readResult,
  logEvent,
  newStepId,
  getTask,
  type StepRecord,
  type TaskRecord,
} from "./blackboard.ts";
import {
  newBudgetState,
  consumeBudget,
  budgetRemaining,
  CircuitBreaker,
  checkpointFromResult,
  escalateHitl,
} from "./resilience.ts";
import {
  setupIntegration,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  commitAllInWorktree,
  removeIntegrationWorktree,
  createCandidateWorktree,
  promoteCandidateToIntegration,
  discardCandidate,
  git,
  integrationBranch,
  type WorktreeHandle,
} from "./worktree.ts";
import { buildWorkerPrompt } from "./prompts/roles.ts";
import { checkHealthForAgents, formatHealthReport } from "./workers/health.ts";

/** Ограниченный пул конкурентности: не больше maxParallel одновременно. Сохраняет порядок результатов. */
export async function runBounded<T, U>(
  items: T[],
  maxParallel: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.max(1, Math.min(maxParallel, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export interface RunOptions {
  workflowPath: string;
  prompt: string;
  project: string;
  /** env для GLM (base url + key), если в воркфлоу есть glm-шаги. */
  glmEnv?: Record<string, string>;
  /** env для ollama (OLLAMA_BASE_URL / OLLAMA_MODEL), если в fan_out есть ollama.
   *  runOllama читает process.env напрямую, но раннер должен загрузить эти
   *  переменные (напр. из .env.local) ДО запуска, чтобы health-gate и worker
   *  их видели. Task 11 загружает .env.local и выставляет process.env. */
  ollamaEnv?: Record<string, string>;
  /** Лимит параллельных воркеров (PLAN §5: потолок 3). */
  maxParallel?: number;
}

export interface RunResult {
  task: TaskRecord;
  success: boolean;
}

/** Загрузить и провалидировать воркфлоу из YAML. */
export async function loadWorkflow(path: string): Promise<LoadedWorkflow> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  const wf = WorkflowSchema.parse(parsed);
  return buildLoadedWorkflow(wf);
}

/** Найти вывод предыдущего шага для подстановки в envelope.context. */
async function contextFromPrevStep(
  taskId: string,
  step: ResolvedStep,
  allSteps: ResolvedStep[],
  iteration = 1,
): Promise<string | null> {
  if (step.depends_on.length === 0) return null;
  // Берём результат последнего завершённого dep-шага (той же итерации).
  for (const depId of [...step.depends_on].reverse()) {
    const dep = allSteps.find((s) => s.id === depId);
    if (!dep) continue;
    const depStepId = newStepId(taskId, allSteps.indexOf(dep) + 1, iteration);
    const res = await readResult(taskId, depStepId);
    if (res && typeof res === "object" && "output" in res) {
      return String((res as { output: string }).output).slice(0, 8000);
    }
  }
  return null;
}

/** Вердикт review/final — условие выхода из цикла. */
type Verdict = "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "ACCEPT" | null;

/**
 * Распарсить вердикт из output шага review (APPROVE|REQUEST_CHANGES|REJECT)
 * или final (ACCEPT|REJECT). Формат зафиксирован в src/prompts/roles.ts.
 * null = вердикт не найден (трактуем как REQUEST_CHANGES — безопасно).
 */
async function parseVerdict(taskId: string, stepId: string): Promise<Verdict> {
  const res = await readResult(taskId, stepId);
  if (!res || typeof res !== "object" || !("output" in res)) return null;
  const output = String((res as { output: string }).output);
  // Ищем последнюю строку VERDICT: ... (на случай markdown-обрамления).
  const m = output.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|REJECT|ACCEPT)\b/i);
  if (!m) return null;
  return m[1]!.toUpperCase() as Verdict;
}

/** Результат запуска шага — для проверки вердикта в runWorkflow. */
interface StepRun {
  result: WorkerResult;
  stepId: string;
  output: string;
}

/** Результат runWorkerOnly: передаёт результат воркера + handle созданного worktree. */
interface WorkerOnlyResult {
  result: WorkerResult;
  stepId: string;
  output: string;
  /** Созданный worktree (для editing-ролей на линейном пути), либо null
   *  (review/final, или когда caller передал cwdOverride/skipWorktree). */
  wt: WorktreeHandle | null;
  /** cwd, в котором воркер реально работал. */
  cwd: string;
}

/** Опции runWorkerOnly. На линейном пути runStep выставляет iteration +
 *  cwdOverride (для review/final) + contextOverride (для plan в loop). */
interface WorkerOnlyOpts {
  iteration?: number;
  /** Суффикс подзадачи в stepId ("~P1" / "~P1r") и в имени ветки. Для fan-out. */
  subtaskSuffix?: string;
  /** Запустить воркер в этом cwd вместо создания worktree (review/final на
   *  линейном пути — integration-worktree; кандидатный review при fan-out). */
  cwdOverride?: string;
  /** Не создавать worktree вовсе (использовать cwdOverride). */
  skipWorktree?: boolean;
  /** true для plan-шага в fan-out воркфлоу — требовать строгий JSON SubtaskPlan. */
  fanOut?: boolean;
  /** Явный context (для цикла: раннер сам считает по итерации).
   *  Если undefined → contextFromPrevStep (для editing-ролей) или null
   *  (для review-in-candidate при fan-out). */
  contextOverride?: string | null;
}

/**
 * Часть шага БЕЗ merge: worktree setup (для editing-ролей) → circuit check →
 * envelope → воркер + ретраи → writeResult → checkpoint → breaker record →
 * step record. НЕ делает commit/merge/cleanup — это забота вызывающего
 * (runStep на линейном пути; Task 10 — для fan-out).
 *
 * Возвращает { result, stepId, output, wt, cwd }. Вызывающий по wt решает,
 * нужно ли commit→merge→removeWorktree (линейный путь) или отложить merge
 * (фаза A fan-out).
 */
async function runWorkerOnly(
  taskId: string,
  step: ResolvedStep,
  stepIdx: number,
  prompt: string,
  projectPath: string,
  glmEnv: Record<string, string> | undefined,
  ollamaEnv: Record<string, string> | undefined,
  breaker: CircuitBreaker,
  allSteps: ResolvedStep[],
  o: WorkerOnlyOpts = {},
): Promise<WorkerOnlyResult> {
  const iteration = o.iteration ?? 1;
  const baseStepId = newStepId(taskId, stepIdx + 1, iteration);
  const stepId = o.subtaskSuffix ? `${baseStepId}${o.subtaskSuffix}` : baseStepId;

  // context: явный override (loop plan) > contextFromPrevStep (editing) > null
  // (review-in-candidate при fan-out — контекст уже влит в промпт вызывающим).
  const context =
    o.contextOverride !== undefined
      ? o.contextOverride
      : o.cwdOverride === undefined
        ? await contextFromPrevStep(taskId, step, allSteps, iteration)
        : null;

  // worktree для правящих ролей (implement/refine/fix) — свой, на ветке агента.
  // review/final на линейном пути не создают worktree: runStep выставляет
  // cwdOverride = integrationWtPath. При fan-out кандидатный review тоже идёт
  // через cwdOverride (caller).
  let wt: WorktreeHandle | null = null;
  let cwd = o.cwdOverride ?? projectPath;
  if (!o.skipWorktree && !o.cwdOverride) {
    if (["implement", "refine", "fix"].includes(step.role)) {
      // branchAgent: для fan-out — "<agent>~<subtaskId>" (напр. "ollama~P1"). НО '~'
      // недопустим в git ref-именах (git check-ref-format его режектит). Поэтому в
      // ИМЕНИ ВЕТКИ заменяем '~' на '.' (git-ref-safe), stepId при этом сохраняет '~'
      // (это просто имя файла/JSON-ключа, не ref). Так branch = orch/<task>/ollama.P1,
      // а stepId = <task>-S02~P1 — оба валидны в своих доменах.
      const branchAgent = o.subtaskSuffix
        ? `${step.agent}${o.subtaskSuffix.replace(/~/g, ".")}`
        : step.agent;
      wt = await createWorktree(projectPath, taskId, branchAgent);
      cwd = wt.path;
    }
    // review/final: без cwdOverride сюда не доходим на линейном пути (runStep
    // всегда выставляет cwdOverride = integrationWtPath). При fan-out кандидатный
    // review тоже идёт через cwdOverride.
  }

  // Собрать полный промпт: system(роль, агент) + context + task пользователя.
  // Воркер получает готовый промпт, не сырую задачу (PLAN §5.2).
  // Для plan-шага, питающего fan_out, требуем строгий JSON SubtaskPlan.
  const fanOutPlan = o.fanOut ?? (step.role === "plan" && allSteps.some((s) => s.fan_out && s.from_plan === step.id));
  const fullPrompt = buildWorkerPrompt({
    role: step.role,
    agent: step.agentName,
    family: step.family,
    task: prompt,
    context,
    targetPaths: step.target_paths,
    fanOut: fanOutPlan,
  });

  const envelope: TaskEnvelope = makeEnvelope({
    id: stepId,
    agent: step.agent,
    role: step.role,
    prompt: fullPrompt,
    target_paths: step.target_paths,
    context,
    budget: step.budget,
    effort: step.effort,
    allow_same_family: step.allow_same_family,
  });

  // env для воркера: glm → glmEnv (base url + key), ollama → ollamaEnv.
  // ВАЖНО: runOllama также читает OLLAMA_BASE_URL/OLLAMA_MODEL напрямую из
  // process.env (Task 11 выставляет их через dotenv из .env.local). ollamaEnv
  // передаётся сюда для forward-compat — но реальная проводка через process.env.
  const envFor = step.agent === "glm" ? glmEnv : step.agent === "ollama" ? ollamaEnv : undefined;

  const workerOpts: WorkerRunOptions = {
    cwd,
    env: envFor,
  };

  const worker = getWorker(step.agent);
  if (breaker.isTripped(step.agent)) {
    await escalateHitl({
      task_id: taskId,
      step_id: stepId,
      reason: `circuit breaker tripped on agent '${step.agent}'`,
      detail: { failures: breaker.getFailures(step.agent) },
    });
    return {
      result: {
        exit_ok: false,
        exit_code: null,
        output: "",
        timed_out: false,
        has_output: false,
        has_changes: null,
        signals: [],
        success: false,
        reason: "error",
        stderr: "circuit breaker tripped",
        duration_ms: 0,
      },
      stepId,
      output: "",
      wt,
      cwd,
    };
  }

  const record: StepRecord = {
    id: stepId,
    task_id: taskId,
    agent: step.agent,
    family: step.family,
    role: step.role,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    attempts: 1,
    result_path: null,
    error: null,
  };
  await upsertStep(taskId, record);

  const budget = newBudgetState(stepId);
  let result: WorkerResult;
  try {
    result = await worker(envelope, workerOpts);
    const consumed = consumeBudget(budget, envelope, result);
    record.attempts = consumed.attempts;

    // Ретраи в пределах max_steps, если не успех и бюджет не исчерпан.
    // review #3: таймаут каждой попытки = остаток бюджета (wall_sec_left),
    // иначе N ретраев по wall_time_sec каждый суммарно превышают бюджет шага.
    let cur = consumed;
    while (!result.success && !cur.exhausted && result.reason !== "error") {
      const { wall_sec_left } = budgetRemaining(cur, envelope);
      if (wall_sec_left <= 0) break; // бюджет исчерпан — не ретраим
      const retryOpts: WorkerRunOptions = { ...workerOpts, wallTimeSecOverride: wall_sec_left };
      const retryResult = await worker(envelope, retryOpts);
      cur = consumeBudget(cur, envelope, retryResult);
      if (retryResult.success) {
        result = retryResult;
        break;
      }
      result = retryResult;
      record.attempts = cur.attempts;
    }

    // Записать результат в blackboard (sidecar, §2.5 сигнал #3 для codex)
    const resultPath = await writeResult(taskId, stepId, {
      envelope_id: stepId,
      agent: step.agent,
      role: step.role,
      output: result.output,
      signals: result.signals,
      success: result.success,
      reason: result.reason,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
    });
    record.result_path = resultPath;

    // Checkpoint для codex (§4.3) — раннер пишет digest
    if (step.agent === "codex") {
      // review #4: заполняем files_changed из git status worktree (раньше всегда []).
      let filesChanged: string[] = [];
      try {
        const { stdout: status } = await git(cwd, ["status", "--porcelain"]);
        filesChanged = status.trim().split("\n").filter(Boolean).map((l) => l.slice(3).trim());
      } catch {
        // не git-репо или worktree уже удалён — оставляем []
      }
      await checkpointFromResult(taskId, stepIdx + 1, envelope, result, undefined, filesChanged);
    }

    // Circuit breaker (§4.2)
    if (result.success) breaker.recordSuccess(step.agent);
    else {
      const tripped = breaker.recordFailure(step.agent);
      if (tripped) {
        await escalateHitl({
          task_id: taskId,
          step_id: stepId,
          reason: `circuit breaker tripped after ${breaker.getFailures(step.agent)} failures on '${step.agent}'`,
          detail: { reason: result.reason },
        });
      }
    }

    record.status = result.success ? "success" : "failed";
    record.error = result.success ? null : `${result.reason}: ${result.stderr.slice(0, 500)}`;
  } catch (e) {
    record.status = "failed";
    record.error = e instanceof Error ? e.message : String(e);
    await logEvent({
      task_id: taskId,
      step_id: stepId,
      level: "error",
      kind: "worker_exception",
      message: record.error ?? "unknown",
    });
    result = {
      exit_ok: false,
      exit_code: null,
      output: "",
      timed_out: false,
      has_output: false,
      has_changes: null,
      signals: [],
      success: false,
      reason: "error",
      stderr: record.error ?? "",
      duration_ms: 0,
    };
  } finally {
    record.finished_at = new Date().toISOString();
    await upsertStep(taskId, record);
  }

  return { result, stepId, output: result.output, wt, cwd };
}

/** Запустить один шаг (ЛИНЕЙНЫЙ путь): runWorkerOnly → commit → merge → cleanup.
 *  Делегирует worker-часть в runWorkerOnly; сама делает только integration-merge
 *  для review/final (до запуска воркера) и commit+merge+removeWorktree после успеха. */
async function runStep(
  taskId: string,
  step: ResolvedStep,
  stepIdx: number,
  prompt: string,
  projectPath: string,
  integrationWtPath: string,
  glmEnv: Record<string, string> | undefined,
  ollamaEnv: Record<string, string> | undefined,
  breaker: CircuitBreaker,
  allSteps: ResolvedStep[],
  iteration = 1,
  /** Явный context (для цикла: раннер сам считает по итерации). Если undefined — contextFromPrevStep. */
  contextOverride?: string | null,
): Promise<StepRun> {
  // review/final: работают в integration-worktree, где виден смерженный код
  //  (иначе reviewer смотрит на пустой main и не видит работу implementer-а).
  //  Обновим integration до последнего merge, затем передадим cwdOverride в
  //  runWorkerOnly, чтобы оно не создавало собственный worktree.
  let cwdOverride: string | undefined;
  if (["review", "final"].includes(step.role)) {
    await git(integrationWtPath, ["merge", "--ff-only", integrationBranch(taskId)]).catch(() => {});
    cwdOverride = integrationWtPath;
  }

  // context считаем ЗДЕСЬ, как старый runStep: явный override > contextFromPrevStep.
  // ВАЖНО: передаём конкретное string|null, а не сырой contextOverride (который
  // для review/final === undefined). Иначе runWorkerOnly при cwdOverride !== undefined
  // вернёт null и дропнет контекст рецензента (имплементация предыдущего шага).
  const ctx =
    contextOverride !== undefined
      ? contextOverride
      : await contextFromPrevStep(taskId, step, allSteps, iteration);
  const { result, stepId, output, wt } = await runWorkerOnly(
    taskId,
    step,
    stepIdx,
    prompt,
    projectPath,
    glmEnv,
    ollamaEnv,
    breaker,
    allSteps,
    { iteration, cwdOverride, contextOverride: ctx },
  );

  // Merge worktree в integration после успеха (только для editing-ролей — у
  //  review/final wt === null). Сначала коммитим все правки воркера, иначе они
  //  потеряются при worktree remove.
  if (wt && result.success) {
    const committed = await commitAllInWorktree(
      wt,
      `orch(${step.agent}/${step.role}): ${stepId}`,
    );
    if (!committed) {
      await logEvent({
        task_id: taskId,
        step_id: stepId,
        level: "warn",
        kind: "no_changes_to_commit",
        message: `step ${step.role} (${step.agent}) succeeded but made no file changes`,
      });
    }
    const mergeRes = await mergeWorktree(integrationWtPath, wt);
    if (!mergeRes.ok) {
      await escalateHitl({
        task_id: taskId,
        step_id: stepId,
        reason: mergeRes.conflict ? "merge conflict" : "merge error",
        detail: { message: mergeRes.message },
      });
    }
    await removeWorktree(projectPath, wt);
  }

  return { result, stepId, output };
}

// ─── Fan-out (Task 10): two-phase merge ─────────────────────────────────────
//
// Phase A — implement параллельно через runBounded (каждая подзадача в своём
//           worktree, БЕЗ merge в integration). Коммитим правки в implement-ветку,
//           но оставляем merge на Phase B.
// Phase B — СТРОГО последовательно: для каждой подзадачи создаём disposable
//           candidate-ветку от текущей integration, мержим туда implement-ветку,
//           проверяем diff-guard (правки только в target_paths), гоняем codex-review
//           в candidate-worktree, и ТОЛЬКО при APPROVE продвигаем candidate в
//           integration (ff). При REJECT/REQUEST_CHANGES/out-of-scope — discard.
//
// Последовательность Phase B критична: параллельные candidate-мержи дали бы гонку
// за HEAD integration (две ветки пытаются ff одну и ту же integration одновременно).
//
// Агрегат пишется под БАЗОВЫМ stepId fan_out-шага (без суффикса подзадачи), чтобы
// downstream-шаги (final с depends_on:[build]) нашли его через contextFromPrevStep.

/** Итог фан-аута: все ли подзадачи одобрены + список провалившихся. */
interface FanOutOutcome {
  allApproved: boolean;
  failedSubtasks: string[];
}

/**
 * Запустить fan_out-шаг: маршрутизация подзадач → Phase A (implement) →
 * Phase B (candidate merge + review + promote) → агрегат под базовым stepId.
 *
 * @param integrationWtPath путь к worktree integration-ветки (от setupIntegration)
 * @param glmEnv env для GLM-исполнителей (base url + key)
 * @param ollamaEnv env для ollama-исполнителей (runOllama читает process.env, но
 *   раннер должен их уже выставить — см. Task 11)
 * @param threshold complexity_threshold из воркфлоу (маршрутизация strong vs local)
 * @param maxParallel потолок параллельности Phase A (effectiveMaxParallel)
 */
async function runFanOut(
  taskId: string,
  spec: FanOutSpec,
  allSteps: ResolvedStep[],
  prompt: string,
  projectPath: string,
  integrationWtPath: string,
  glmEnv: Record<string, string> | undefined,
  ollamaEnv: Record<string, string> | undefined,
  breaker: CircuitBreaker,
  threshold: number,
  maxParallel: number,
): Promise<FanOutOutcome> {
  const stepIdx = allSteps.indexOf(spec.step);
  const planStepIdx = allSteps.findIndex((s) => s.id === spec.fromPlanId);
  // plan-шаг уже исполнен на линейном пути (preLevels); читаем его результат.
  const planStepId = newStepId(taskId, planStepIdx + 1, 1);
  const planResult = await readResult(taskId, planStepId);
  if (!planResult || typeof planResult !== "object" || !("output" in planResult)) {
    await escalateHitl({ task_id: taskId, step_id: planStepId, reason: "fan_out: plan result missing", detail: {} });
    return { allApproved: false, failedSubtasks: ["(no plan)"] };
  }
  const planOutput = String((planResult as { output: string }).output);
  let plan: SubtaskPlan;
  try {
    plan = parsePlan(planOutput);
  } catch (e) {
    await escalateHitl({
      task_id: taskId, step_id: planStepId, reason: "fan_out: parsePlan failed",
      detail: { error: e instanceof Error ? e.message : String(e) },
    });
    return { allApproved: false, failedSubtasks: ["(bad plan)"] };
  }

  // ── Маршрутизация + проверка пересечения target_paths (point #11, strict v1). ──
  type Routed = { subtask: Subtask; agent: AgentName };
  const routed: Routed[] = [];
  const failed: string[] = [];
  for (const subtask of plan.subtasks) {
    try {
      const agent = routeSubtask(subtask, spec.agents, threshold);
      routed.push({ subtask, agent });
    } catch (e) {
      failed.push(subtask.id);
      await escalateHitl({
        task_id: taskId, step_id: null,
        reason: `fan_out: subtask ${subtask.id} unroutable`,
        detail: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }
  // target_paths пересечение — merge-first (ослабление v1).
  // Раньше блокировали upfront (строгий запрет), но реальные задачи (напр.
  // Nest.js бэкенд) неминуемо пересекаются на общих файлах (app.module.ts,
  // package.json). Теперь разрешаем: Phase B мержит подзадачи последовательно
  // в candidate, и только ФАКТИЧЕСКИЙ git-конфликт → discard + failed.
  // Логируем пересечение как warn — для наблюдаемости.
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      if (pathsOverlap(routed[i]!.subtask.target_paths, routed[j]!.subtask.target_paths)) {
        await logEvent({
          task_id: taskId, step_id: null, level: "warn",
          kind: "fanout_path_overlap",
          message: `target_paths overlap between ${routed[i]!.subtask.id} and ${routed[j]!.subtask.id} — will rely on merge-first (git conflict → fail that subtask)`,
          data: { a: routed[i]!.subtask.target_paths, b: routed[j]!.subtask.target_paths },
        });
      }
    }
  }

  // ── Phase A: implement параллельно (БЕЗ merge в integration). ──
  // runBounded ограничивает конкурентность до maxParallel — НИКОГДА не пускаем
  // все implement-ы разом (point #3).
  type PhaseAResult = { subtask: Subtask; agent: AgentName; result: WorkerResult; stepId: string; wt: WorktreeHandle | null };
  const phaseA: (PhaseAResult | null)[] = await runBounded(routed, maxParallel, async ({ subtask, agent }) => {
    if (breaker.isTripped(agent)) {
      await escalateHitl({
        task_id: taskId, step_id: null,
        reason: `circuit breaker tripped on '${agent}' for subtask ${subtask.id}`,
        detail: {},
      });
      failed.push(subtask.id);
      return null;
    }
    // impl-шаг: клонируем spec.step, подставляя реального исполнителя подзадачи.
    // agent может быть "ollama" — поэтому ResolvedStep.agent имеет тип AgentName.
    const implStep: ResolvedStep = {
      ...spec.step,
      agent,
      agentName: agent,
      family: AGENTS[agent].family,
      target_paths: subtask.target_paths,
    };
    // env для воркера: runWorkerOnly сам выбирает glm→glmEnv / ollama→ollamaEnv
    // по step.agent. ollama также читает process.env напрямую (Task 11 — dotenv).
    const { result, stepId, wt } = await runWorkerOnly(
      taskId, implStep, stepIdx,
      `${subtask.goal}\n\nACCEPTANCE CRITERIA: ${subtask.acceptance_criteria}`,
      projectPath, glmEnv, ollamaEnv, breaker, allSteps,
      { subtaskSuffix: `~${subtask.id}` },
    );
    // Коммитим правки в implement-ветку (чтобы они ушли в merge на Phase B), но НЕ мержим.
    if (wt && result.success) {
      await commitAllInWorktree(wt, `orch(${agent}/implement): ${stepId}`);
    }
    if (!result.success) failed.push(subtask.id);
    return { subtask, agent, result, stepId, wt };
  });

  // ── Phase B: candidate merge + review — СТРОГО последовательно (point #2). ──
  // Гонка за HEAD integration при параллельных ff-продвижениях — поэтому один за другим.
  let allApproved = true;
  const summaries: string[] = [];
  for (const item of phaseA) {
    if (!item || !item.result.success || !item.wt) {
      // implement провалился (или breaker, или нет worktree) — пропускаем, cleanup.
      if (item) summaries.push(`- ${item.subtask.id}: FAILED (implement)`);
      allApproved = false;
      if (item?.wt) await removeWorktree(projectPath, item.wt);
      continue;
    }
    if (!spec.review) {
      // Без review — мержим implement-ветку в integration сразу (как линейный путь).
      const mr = await mergeWorktree(integrationWtPath, item.wt);
      if (!mr.ok) {
        failed.push(item.subtask.id);
        allApproved = false;
        summaries.push(`- ${item.subtask.id}: FAILED (merge conflict, no review)`);
      } else {
        summaries.push(`- ${item.subtask.id}: MERGED (no review)`);
      }
      await removeWorktree(projectPath, item.wt);
      continue;
    }
    // С review: candidate от текущей integration + merge implement-ветки в candidate.
    const candidate = await createCandidateWorktree(projectPath, taskId, item.subtask.id);
    // mergeWorktree мержит ветку item.wt.branch в каталог candidate.worktreePath
    // (HEAD там = candidate-ветка). mergeWorktree берёт task_id из handle.
    const cm = await mergeWorktree(candidate.worktreePath, item.wt);
    if (!cm.ok) {
      await discardCandidate(projectPath, candidate);
      await removeWorktree(projectPath, item.wt);
      failed.push(item.subtask.id);
      allApproved = false;
      summaries.push(`- ${item.subtask.id}: FAILED (candidate merge conflict)`);
      continue;
    }
    // diff guard (point #12) — ослаблен: правки вне target_paths логируем как
    // warn, но НЕ блокируем. Реальные бэкенд-задачи неминуемо выходят за область
    // (любой новый модуль требует правки app.module.ts). Phase B merge-first
    // ловит ФАКТИЧЕСКИЕ конфликты при merge в candidate — этого достаточно.
    const { stdout: names } = await git(candidate.worktreePath, ["diff", "--name-only", integrationBranch(taskId), candidate.branch])
      .catch(() => ({ stdout: "" }));
    const changed = names.trim().split("\n").filter(Boolean);
    const tp = item.subtask.target_paths;
    if (tp.length > 0) {
      const outOfScope = changed.filter((f) => !pathsOverlap([f], tp));
      if (outOfScope.length > 0) {
        await logEvent({
          task_id: taskId, step_id: null, level: "warn",
          kind: "fanout_diff_out_of_scope",
          message: `subtask ${item.subtask.id} changed files outside target_paths (allowed — merge-first will catch real conflicts)`,
          data: { outOfScope, target_paths: tp },
        });
      }
    }
    // codex-review в candidate-worktree (видит смерженный код). skipWorktree + cwdOverride,
    // чтобы runWorkerOnly не создавал собственный worktree — ревьюер работает в candidate.
    const reviewStep: ResolvedStep = {
      ...spec.step,
      agent: "codex",
      agentName: "codex",
      family: AGENTS.codex.family,
      role: "review",
    };
    const rr = await runWorkerOnly(
      taskId, reviewStep, stepIdx, buildReviewPrompt(item.subtask),
      projectPath, undefined, undefined, breaker, allSteps,
      { subtaskSuffix: `~${item.subtask.id}r`, cwdOverride: candidate.worktreePath, skipWorktree: true },
    );
    const verdict = await parseVerdict(taskId, rr.stepId);
    if (verdict === "APPROVE" || verdict === "ACCEPT") {
      // APPROVE → продвигаем candidate в integration (ff через integration-worktree), cleanup candidate.
      const prom = await promoteCandidateToIntegration(projectPath, taskId, candidate, integrationWtPath);
      if (prom.ok) {
        summaries.push(`- ${item.subtask.id}: APPROVE (codex)`);
      } else {
        // promote провалился — ff-merge упал ДО cleanup, значит candidate worktree+ветка
        // ещё живы. Вызываем discardCandidate, чтобы не было утечки (он идемпотентен —
        // все git/rm обёрнуты в .catch). Считаем провалом.
        await discardCandidate(projectPath, candidate);
        failed.push(item.subtask.id);
        allApproved = false;
        summaries.push(`- ${item.subtask.id}: APPROVE but promote FAILED (${prom.message})`);
      }
    } else {
      // REJECT / REQUEST_CHANGES / null → discard candidate (без продвижения).
      await discardCandidate(projectPath, candidate);
      failed.push(item.subtask.id);
      allApproved = false;
      summaries.push(`- ${item.subtask.id}: ${verdict ?? "no verdict"} → rejected`);
    }
    // implement-ветка больше не нужна в любом случае (смержена в candidate или candidate выброшен).
    await removeWorktree(projectPath, item.wt);
  }

  // ── Агрегат под базовым stepId (без суффикса подзадачи) — point #2. ──
  // Downstream final с depends_on:[build] найдёт этот результат через contextFromPrevStep.
  const baseStepId = newStepId(taskId, stepIdx + 1, 1);
  await writeResult(taskId, baseStepId, {
    envelope_id: baseStepId,
    agent: "fan_out",
    role: spec.step.role,
    output: summaries.length > 0 ? summaries.join("\n") : "(no subtasks)",
    signals: [],
    success: allApproved,
    reason: allApproved ? null : "partial_failure",
    duration_ms: 0,
    timed_out: false,
  });

  return { allApproved, failedSubtasks: failed };
}

/** Сборка промпта для codex-review подзадачи в candidate-worktree. */
function buildReviewPrompt(subtask: Subtask): string {
  return [
    "Review the implementation of this subtask in the current worktree.",
    "The worktree is a candidate branch containing the implementer's changes merged on top of integration.",
    "",
    `SUBTASK GOAL: ${subtask.goal}`,
    `ACCEPTANCE CRITERIA: ${subtask.acceptance_criteria}`,
    `TARGET PATHS: ${subtask.target_paths.join(", ") || "(none)"}`,
    "",
    "Use your normal review tools to read the diff and the files.",
    "Return your standard review format ending with VERDICT: APPROVE | REQUEST_CHANGES | REJECT.",
  ].join("\n");
}

/**
 * Graceful shutdown при внешнем SIGTERM/SIGINT (напр. UI "Остановить",
 * таймаут Bash, Ctrl+C). Без этого процесс умирает, а задача остаётся в
 * `running` навсегда (runWorkerOnly не дописывает статус шага).
 *
 * Регистрируем ОДИН обработчик после createTask; при сигнале:
 *  - помечаем висящие running-шаги → failed
 *  - задача → failed
 *  - cleanup integration worktree (если уже создан)
 *  - логируем причину
 *  - выходим (не блокируем сигнал — позволяем процессу умереть)
 *
 * handleRef возвращает функцию снятия регистрации (для нормального пути).
 */
export function installShutdownHandler(
  taskId: string,
  projectPath: string,
  integrationRef: { value: { branch: string; worktreePath: string } | null },
): () => void {
  const handler = async (sig: NodeJS.Signals) => {
    // Предотвращаем повторный вход (второй SIGKILL всё равно добьёт).
    process.removeAllListeners(sig);
    console.error(`\n⚠ received ${sig} — graceful shutdown of task ${taskId}`);
    try {
      // 1. Помечаем висящие running-шаги → failed.
      const task = await getTask(taskId);
      if (task) {
        let changed = false;
        for (const st of task.steps) {
          if (st.status === "running") {
            st.status = "failed";
            st.finished_at = new Date().toISOString();
            st.error = `interrupted by ${sig}`;
            changed = true;
          }
        }
        if (changed) {
          await updateTask(taskId, { status: "failed", steps: task.steps });
        } else {
          await updateTask(taskId, { status: "failed" });
        }
        await logEvent({
          task_id: taskId, step_id: null, level: "error",
          kind: "graceful_shutdown", message: `task interrupted by ${sig}; marked failed`,
          data: { interrupted_steps: task.steps.filter((s) => s.error === `interrupted by ${sig}`).map((s) => s.id) },
        });
      }
      // 2. Cleanup integration worktree (ветку оставляем для разбора).
      if (integrationRef.value) {
        await removeIntegrationWorktree(projectPath, integrationRef.value.worktreePath).catch(() => {});
      }
    } catch (e) {
      // Даже если не успели записать — не блокируем выход.
      console.error(`  (shutdown cleanup failed: ${e instanceof Error ? e.message : e})`);
    }
    process.exit(130); // 128+SIGINT по конвенции; подойдёт и для SIGTERM.
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGTERM", handler);
    process.off("SIGINT", handler);
  };
}

/** Точка входа раннера: запустить воркфлоу над проектом. */
export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const loaded = await loadWorkflow(opts.workflowPath);
  const { preLevels, postFanOutLevels, loopBody, loop, postLevels, allSteps, fanOuts } = loaded;
  const projectPath = opts.project;
  // effectiveMaxParallel (point #7): opts.maxParallel ?? wf.max_parallel ?? 3.
  const effectiveMaxParallel = opts.maxParallel ?? loaded.wf.max_parallel ?? 3;
  const threshold = loaded.wf.complexity_threshold;
  // ollama env: runOllama читает process.env напрямую, но раннер должен знать
  // о нём для health-gate и логирования (Task 11 выставляет process.env из .env.local).
  const ollamaEnv = opts.ollamaEnv;

  // ─── Health gate: проверить все агенты воркфлоу ДО создания задачи ───
  // point #8: uniqueAgents ДОЛЖНЫ включать fanOuts[].agents — иначе ollama
  // (если он есть только в fan_out) не пройдёт health-check и упадёт на запуске.
  // review #1 (Codex): при fan_out.review codex — динамический ревьюер, его
  // нет в agents, но он зовётся на каждой подзадаче. Добавляем явно.
  const uniqueAgents = Array.from(new Set([
    ...allSteps.filter((s) => !s.fan_out).map((s) => s.agentName),
    ...fanOuts.flatMap((f) => f.agents),
    ...fanOuts.filter((f) => f.review).map(() => "codex" as AgentName),
  ]));
  const healthResults = await checkHealthForAgents(uniqueAgents, opts.glmEnv);
  const unhealthy: AgentName[] = [];
  for (const [agent, r] of healthResults) {
    if (!r.healthy) unhealthy.push(agent);
  }
  if (unhealthy.length > 0) {
    const report = formatHealthReport(healthResults);
    throw new Error(
      `Health check failed for: ${unhealthy.join(", ")}. Fix before running workflow.\n\n${report}`,
    );
  }

  // ─── Валидация target-репо ДО создания задачи ───
  // setupIntegration делает `git branch <integration> main` — падает на репо
  // без коммитов (main не валидный object). Проверяем upfront, чтобы дать
  // понятную ошибку, а не бросать необработанное исключение посреди задачи.
  try {
    await git(projectPath, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(
      `Target project is not a usable git repo (no commits on HEAD): ${projectPath}\n` +
      `Make at least one commit before running a workflow (orchestrator creates branches off HEAD).`,
    );
  }

  const task = await createTask({
    prompt: opts.prompt,
    workflow: opts.workflowPath,
    project: projectPath,
    status: "running",
  });

  // Оборачиваем тело в try/catch: при ЛЮБОЙ необработанной ошибке (напр.
  // git-падение в setupIntegration/merge) ставить задаче status=failed и
  // логировать, а не бросать наружу — иначе задача висит в running навсегда.
  // integrationRef — обёртка, чтобы shutdown-handler видел актуальное значение
  // integration (let-переменная не видна в замыкании после reassign).
  const integrationRef: { value: { branch: string; worktreePath: string } | null } = { value: null };
  // Graceful shutdown: при внешнем SIGTERM/SIGINT (UI stop, таймаут, Ctrl+C)
  // помечаем задачу failed и чистим worktree — иначе зависает в running.
  const removeShutdownHandler = installShutdownHandler(task.id, projectPath, integrationRef);
  let integration: { branch: string; worktreePath: string } | null = null;
  try {
    // Integration живёт в собственном worktree — НЕ трогает HEAD основного репо.
    integration = await setupIntegration(projectPath, task.id);
    integrationRef.value = integration;
    const integrationWtPath = integration.worktreePath;

  const breaker = new CircuitBreaker(3);
  let overallSuccess = true;

  // ─── Линейная часть (pre-loop): DAG по уровням ───
  for (const level of preLevels) {
    const parallelizable = level.length > 1;
    const concurrency = parallelizable ? Math.min(level.length, effectiveMaxParallel) : 1;
    if (concurrency > 1) {
      // runBounded ограничивает параллельность реальным потолком (review #2):
      // Promise.all(level.map(...)) запускал бы весь уровень разом, игнорируя
      // effectiveMaxParallel. runBounded сохраняет порядок результатов.
      const results = await runBounded(level, concurrency, (step) =>
        runStep(task.id, step, allSteps.indexOf(step), opts.prompt, projectPath, integrationWtPath, opts.glmEnv, ollamaEnv, breaker, allSteps),
      );
      if (!results.every((r) => r.result.success)) overallSuccess = false;
    } else {
      for (const step of level) {
        const r = await runStep(task.id, step, allSteps.indexOf(step), opts.prompt, projectPath, integrationWtPath, opts.glmEnv, ollamaEnv, breaker, allSteps);
        if (!r.result.success) {
          overallSuccess = false;
          break; // На последовательном уровне — не продолжаем после провала (HITL).
        }
      }
    }
    if (!overallSuccess) break; // провал на уровне — не идём дальше
  }

  // ─── Fan-out (если есть) — после preLevels, до postFanOutLevels/цикла ───
  // point #1: Phase A (parallel implement) + Phase B (sequential candidate merge).
  // plan-шаг (fromPlanId) уже исполнен в preLevels; читаем его результат внутри runFanOut.
  if (overallSuccess && fanOuts.length > 0) {
    for (const spec of fanOuts) {
      const fo = await runFanOut(
        task.id, spec, allSteps, opts.prompt, projectPath,
        integrationWtPath, opts.glmEnv, ollamaEnv, breaker,
        threshold, effectiveMaxParallel,
      );
      if (!fo.allApproved) overallSuccess = false;
    }
  }

  // ─── Шаги, зависящие от fan_out (напр. final с depends_on:[build]) ───
  // Исполняются ПОСЛЕ fan-out — найдут агрегат fan-out через contextFromPrevStep.
  if (overallSuccess) {
    for (const level of postFanOutLevels) {
      for (const step of level) {
        const r = await runStep(
          task.id, step, allSteps.indexOf(step), opts.prompt,
          projectPath, integrationWtPath, opts.glmEnv, ollamaEnv, breaker, allSteps,
        );
        if (!r.result.success) {
          overallSuccess = false;
          break;
        }
      }
      if (!overallSuccess) break;
    }
  }

  // ─── Цикл (если есть) ───
  // Тело исполняется последовательно по кругам. Условие выхода — вердикт
  // шага loop.exit_on: APPROVE → выход, REJECT → HITL, REQUEST_CHANGES →
  // следующий круг. Лимит max_iterations; при исчерпании → on_exhausted.
  let loopApproved = false;
  if (overallSuccess && loop) {
    const exitStepIdx = allSteps.findIndex((s) => s.id === loop.exit_on);
    let iteration = 0;
    while (iteration < loop.max_iterations && !loopApproved) {
      iteration++;
      let stepFailed = false;
      for (const step of loopBody) {
        // На 2+ круге plan получает контекст = вердикт review прошлого круга.
        // contextFromPrevStep внутри runStep читает результат dep-шага той же
        // итерации — для plan на 2+ круге это будет review прошлой итерации
        // через depends_on... но review прошлой итерации имеет другой stepId.
        // Поэтому для plan на итерации >1 передаём contextOverride явно.
        let contextOverride: string | undefined = undefined;
        if (iteration > 1 && step.role === "plan") {
          // Прочитать вердикт review прошлой итерации как context для нового плана.
          const reviewStep = loopBody.find((s) => s.role === "review") ?? loopBody.find((s) => s.role === "final");
          if (reviewStep) {
            const reviewStepId = newStepId(task.id, allSteps.indexOf(reviewStep) + 1, iteration - 1);
            const prevReview = await readResult(task.id, reviewStepId);
            if (prevReview && typeof prevReview === "object" && "output" in prevReview) {
              contextOverride = String((prevReview as { output: string }).output).slice(0, 8000);
            }
          }
        }
        const r = await runStep(
          task.id, step, allSteps.indexOf(step), opts.prompt,
          projectPath, integrationWtPath, opts.glmEnv, ollamaEnv, breaker, allSteps,
          iteration, contextOverride,
        );
        if (!r.result.success) {
          stepFailed = true;
          overallSuccess = false;
          break;
        }
      }
      if (stepFailed) break;

      // Проверить вердикт exit_on-шага.
      const exitStepId = newStepId(task.id, exitStepIdx + 1, iteration);
      const verdict = await parseVerdict(task.id, exitStepId);
      await logEvent({
        task_id: task.id, step_id: exitStepId,
        // null-вердикт = промпт ревьюера съехал, VERDICT: не распарсился.
        // Трактуется безопасно (REQUEST_CHANGES), но логируем как warn — loud failure
        // > quiet success (review #6).
        level: verdict === null ? "warn" : "info",
        kind: "loop_verdict",
        message: `iteration ${iteration}/${loop.max_iterations}: verdict=${verdict ?? "(unparsed)"}`,
      });
      if (verdict === "APPROVE" || verdict === "ACCEPT") {
        loopApproved = true;
      } else if (verdict === "REJECT") {
        await escalateHitl({
          task_id: task.id, step_id: exitStepId,
          reason: `loop exit step '${loop.exit_on}' returned REJECT on iteration ${iteration}`,
          detail: { verdict, iteration },
        });
        overallSuccess = false;
        break;
      }
      // null (не распарсился) → трактуем как REQUEST_CHANGES (безопасно, лог выше).
    }

    if (!loopApproved && overallSuccess) {
      // Лимит исчерпан без APPROVE.
      const lastExitId = newStepId(task.id, exitStepIdx + 1, iteration);
      await escalateHitl({
        task_id: task.id, step_id: lastExitId,
        reason: `loop exhausted ${loop.max_iterations} iterations without APPROVE`,
        detail: { on_exhausted: loop.on_exhausted },
      });
      if (loop.on_exhausted === "hitl") overallSuccess = false;
      // on_exhausted: accept → overallSuccess остаётся true (берём как есть)
    }
  }

  // ─── Post-loop линейные шаги (если есть) ───
  // Исполняются после выхода из цикла (напр. final — финальная приёмка).
  if (overallSuccess) {
    for (const level of postLevels) {
      for (const step of level) {
        const r = await runStep(
          task.id, step, allSteps.indexOf(step), opts.prompt,
          projectPath, integrationWtPath, opts.glmEnv, ollamaEnv, breaker, allSteps,
        );
        if (!r.result.success) {
          overallSuccess = false;
          break;
        }
      }
      if (!overallSuccess) break;
    }
  }

  await updateTask(task.id, { status: overallSuccess ? "done" : "escalated_hitl" });

  // При провале — cleanup integration worktree (ветку оставляем для разбора).
  // При успехе — worktree живёт до acceptTask (ветка нужна для merge в main).
  // point #9 (исключение): при ЧАСТИЧНОМ провале fan-out НЕ удаляем integration-worktree —
  // там уже живут смерженные хорошие подзадачи (нужны для разбора/восстановления).
  // Оставляем также ветку (integrationBranch) — она не удаляется здесь в любом случае.
  const fanOutRan = fanOuts.length > 0;
  if (!overallSuccess && !fanOutRan) {
    await removeIntegrationWorktree(projectPath, integrationWtPath);
  }

  const final = (await updateTask(task.id, {})) as TaskRecord;
  return { task: final, success: overallSuccess };

  } catch (err) {
    // Необработанная ошибка в теле — задача не должна висеть в running.
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent({
      task_id: task.id, step_id: null, level: "error",
      kind: "runner_uncaught", message: msg,
    });
    await updateTask(task.id, { status: "failed" });
    if (integration) {
      await removeIntegrationWorktree(projectPath, integration.worktreePath).catch(() => {});
    }
    // ^ integration.worktreePath безопасен здесь: внутри if (integration) — TS сужает.
    throw err; // пере-бросаем: CLI покажет ошибку пользователю.
  } finally {
    // Нормальный выход — снимаем shutdown-handler, чтобы он не сработал
    // на последующих задачах (если раннер переиспользуется в одном процессе).
    removeShutdownHandler();
    integrationRef.value = null;
  }
}
