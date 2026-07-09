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
  type ResolvedStep,
  type LoadedWorkflow,
} from "./workflow.ts";
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
  git,
  integrationBranch,
  type WorktreeHandle,
} from "./worktree.ts";
import { buildWorkerPrompt } from "./prompts/roles.ts";
import { checkHealthForAgents, formatHealthReport } from "./workers/health.ts";
import type { AgentName } from "./families.ts";

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

/** Запустить один шаг: worktree → envelope → воркер → сигналы → blackboard. */
async function runStep(
  taskId: string,
  step: ResolvedStep,
  stepIdx: number,
  prompt: string,
  projectPath: string,
  integrationWtPath: string,
  glmEnv: Record<string, string> | undefined,
  breaker: CircuitBreaker,
  allSteps: ResolvedStep[],
  iteration = 1,
  /** Явный context (для цикла: раннер сам считает по итерации). Если undefined — contextFromPrevStep. */
  contextOverride?: string | null,
): Promise<StepRun> {
  const stepId = newStepId(taskId, stepIdx + 1, iteration);
  const context =
    contextOverride !== undefined
      ? contextOverride
      : await contextFromPrevStep(taskId, step, allSteps, iteration);

  // worktree для правящих ролей (implement/refine/fix) — свой, на ветке агента.
  // review/final — работают в integration-worktree, где виден смерженный код
  //  (иначе reviewer смотрит на пустой main и не видит работу implementer-а).
  let wt: WorktreeHandle | null = null;
  let cwd = projectPath;
  if (["implement", "refine", "fix"].includes(step.role)) {
    wt = await createWorktree(projectPath, taskId, step.agent);
    cwd = wt.path;
  } else if (["review", "final"].includes(step.role)) {
    // integration-worktree уже создан в setupIntegration; в нём HEAD = integration,
    // и смерженные коммиты видны. Обновим до последнего merge перед review.
    await git(integrationWtPath, ["merge", "--ff-only", integrationBranch(taskId)]).catch(() => {});
    cwd = integrationWtPath;
  }

  // Собрать полный промпт: system(роль, агент) + context + task пользователя.
  // Воркер получает готовый промпт, не сырую задачу (PLAN §5.2).
  const fullPrompt = buildWorkerPrompt({
    role: step.role,
    agent: step.agentName,
    family: step.family,
    task: prompt,
    context,
    targetPaths: step.target_paths,
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

  const workerOpts: WorkerRunOptions = {
    cwd,
    env: step.agent === "glm" ? glmEnv : undefined,
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
    let cur = consumed;
    while (!result.success && !cur.exhausted && result.reason !== "error") {
      const retryResult = await worker(envelope, workerOpts);
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
      await checkpointFromResult(taskId, stepIdx + 1, envelope, result);
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

  // Merge worktree в integration после успеха.
  // Сначала коммитим все правки воркера — иначе они потеряются при worktree remove.
  if (wt && result.success) {
    const committed = await commitAllInWorktree(
      wt,
      `orch(${step.agent}/${step.role}): ${envelope.id}`,
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

  return { result, stepId, output: result.output };
}

/** Точка входа раннера: запустить воркфлоу над проектом. */
export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const loaded = await loadWorkflow(opts.workflowPath);
  const { preLevels, loopBody, loop, postLevels, allSteps } = loaded;
  const projectPath = opts.project;
  const maxParallel = opts.maxParallel ?? 3;

  // ─── Health gate: проверить все агенты воркфлоу ДО создания задачи ───
  const uniqueAgents = Array.from(new Set(allSteps.map((s) => s.agentName)));
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

  const task = await createTask({
    prompt: opts.prompt,
    workflow: opts.workflowPath,
    project: projectPath,
    status: "running",
  });
  // Integration живёт в собственном worktree — НЕ трогаем HEAD основного репо.
  const integration = await setupIntegration(projectPath, task.id);

  const breaker = new CircuitBreaker(3);
  let overallSuccess = true;

  // ─── Линейная часть (pre-loop): DAG по уровням ───
  for (const level of preLevels) {
    const parallelizable = level.length > 1;
    const concurrency = parallelizable ? Math.min(level.length, maxParallel) : 1;
    if (concurrency > 1) {
      const results = await Promise.all(
        level.map((step) =>
          runStep(task.id, step, allSteps.indexOf(step), opts.prompt, projectPath, integration.worktreePath, opts.glmEnv, breaker, allSteps),
        ),
      );
      if (!results.every((r) => r.result.success)) overallSuccess = false;
    } else {
      for (const step of level) {
        const r = await runStep(task.id, step, allSteps.indexOf(step), opts.prompt, projectPath, integration.worktreePath, opts.glmEnv, breaker, allSteps);
        if (!r.result.success) {
          overallSuccess = false;
          break; // На последовательном уровне — не продолжаем после провала (HITL).
        }
      }
    }
    if (!overallSuccess) break; // провал на уровне — не идём дальше
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
          projectPath, integration.worktreePath, opts.glmEnv, breaker, allSteps,
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
        task_id: task.id, step_id: exitStepId, level: "info", kind: "loop_verdict",
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
          projectPath, integration.worktreePath, opts.glmEnv, breaker, allSteps,
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
  if (!overallSuccess) {
    await removeIntegrationWorktree(projectPath, integration.worktreePath);
  }

  const final = (await updateTask(task.id, {})) as TaskRecord;
  return { task: final, success: overallSuccess };
}
