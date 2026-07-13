/**
 * Git worktrees для воркеров + слияние результатов (PLAN §4.5).
 *
 * На задачу — интеграционная ветка orch/<task-id>/integration со СВОИМ
 * worktree (чтобы не трогать HEAD основного репо пользователя). Каждому
 * воркеру — worktree на ветке orch/<task-id>/<agent>.
 *
 * Параллельность только на непересекающихся target_paths (§4.5.2).
 * Merge — последовательный, раннером, после завершения ВСЕХ воркеров шага (§4.5.3).
 * Конфликт → HITL, не автопочинка (§4.5.4).
 *
 * ВАЖНО: ни одна функция здесь не делает `git checkout` в основном репо —
 * все операции идут через worktree-каталоги, чтобы рабочий каталог
 * пользователя оставался нетронутым.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logEvent } from "./blackboard.ts";

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd });
}

export interface WorktreeHandle {
  agent: string;
  task_id: string;
  branch: string;
  /** Путь к worktree (временный каталог). */
  path: string;
  /** Был ли создан нами (надо удалить потом). */
  created: boolean;
}

function branchName(taskId: string, agent: string): string {
  return `orch/${taskId}/${agent}`;
}

export function integrationBranch(taskId: string): string {
  return `orch/${taskId}/integration`;
}

/**
 * Подготовить integration: создать ветку от base + собственный worktree.
 * Возвращает путь к integration-worktree — туда будут мержиться ветки воркеров.
 * НЕ трогает HEAD основного репо.
 */
export async function setupIntegration(
  projectPath: string,
  taskId: string,
  base?: string,
): Promise<{ branch: string; worktreePath: string }> {
  const branch = integrationBranch(taskId);
  const wtPath = await mkdtemp(join(tmpdir(), `orch-${taskId}-integration-`));

  // review #8 (review-2026-07-13): детектить base вместо хардкода "main".
  // Репо с master/develop/detached HEAD раньше падали на git branch <int> main.
  const baseRef = base ?? (await detectBaseRef(projectPath));

  // Если integration-ветка уже есть — пересоздаём worktree на ней.
  try {
    await git(projectPath, ["branch", branch, baseRef]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists|exists/.test(msg)) throw e;
  }

  // worktree, отслеживающий integration-ветку (без --detach).
  await git(projectPath, ["worktree", "add", wtPath, branch]);
  return { branch, worktreePath: wtPath };
}

/**
 * Детектнуть base ref для integration-ветки.
 * review #8 (review-2026-07-13): репо может не иметь main (master/develop).
 * 1. symbolic-ref --short HEAD → имя текущей ветки (напр. "master").
 * 2. fallback на HEAD SHA (detached HEAD).
 */
export async function detectBaseRef(projectPath: string): Promise<string> {
  try {
    const { stdout } = await git(projectPath, ["symbolic-ref", "--short", "HEAD"]);
    const ref = stdout.trim();
    if (ref) return ref;
  } catch {
    // detached HEAD — symbolic-ref падает.
  }
  const { stdout: sha } = await git(projectPath, ["rev-parse", "HEAD"]);
  return sha.trim();
}

/**
 * Создать worktree для воркера на собственной ветке от integration.
 * Возвращает путь — туда воркер делает свою работу.
 */
export async function createWorktree(
  projectPath: string,
  taskId: string,
  agent: string,
): Promise<WorktreeHandle> {
  const branch = branchName(taskId, agent);
  const integration = integrationBranch(taskId);
  const tmpDir = await mkdtemp(join(tmpdir(), `orch-${taskId}-${agent}-`));

  // Ветка от integration (чтобы merge был простым).
  try {
    await git(projectPath, ["branch", branch, integration]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists|exists/.test(msg)) throw e;
  }

  // ВАЖНО: НЕ --detach. Worktree должен отслеживать ветку `branch`, иначе
  // коммиты воркера уйдут в detached HEAD и потеряются при worktree remove.
  await git(projectPath, ["worktree", "add", tmpDir, branch]);
  return { agent, task_id: taskId, branch, path: tmpDir, created: true };
}

/**
 * Закоммитить все изменения в worktree (включая untracked).
 * Воркеры (claude/codex) НЕ обязаны коммитить сами — раннер делает это перед
 * merge, иначе правки теряются при `git worktree remove`.
 * @returns true если был создан коммит, false если изменений не было.
 */
export async function commitAllInWorktree(
  handle: WorktreeHandle,
  message: string,
): Promise<boolean> {
  const cwd = handle.path;
  try {
    await git(cwd, ["add", "-A"]);
    const { stdout: status } = await git(cwd, ["status", "--porcelain"]);
    if (status.trim().length === 0) return false;
    await git(cwd, ["commit", "-m", message, "--no-verify"]);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/nothing to commit|no changes/.test(msg)) return false;
    throw e;
  }
}

/**
 * Слить ветку воркера в integration через integration-worktree.
 * НЕ трогает HEAD основного репо — merge идёт в каталоге integration-worktree.
 * @param integrationWtPath путь к worktree integration-ветки (от setupIntegration)
 */
export async function mergeWorktree(
  integrationWtPath: string,
  handle: WorktreeHandle,
): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  const integration = integrationBranch(handle.task_id);
  try {
    // merge в каталоге integration-worktree — HEAD там = integration.
    const { stdout } = await git(integrationWtPath, [
      "merge",
      "--no-ff",
      handle.branch,
      "-m",
      `merge ${handle.agent} → ${integration}`,
    ]);
    return { ok: true, conflict: false, message: stdout };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const conflict = /CONFLICT|conflict/i.test(msg);
    await logEvent({
      task_id: handle.task_id,
      step_id: null,
      level: "error",
      kind: conflict ? "merge_conflict" : "merge_error",
      message: `merge ${handle.branch} → ${integration} failed: ${msg}`,
    });
    // При конфликте — abort, чтобы integration-worktree остался чистым.
    try {
      await git(integrationWtPath, ["merge", "--abort"]);
    } catch {
      // ignore
    }
    return { ok: false, conflict, message: msg };
  }
}

/** Удалить worktree воркера и его ветку (cleanup после merge). */
export async function removeWorktree(projectPath: string, handle: WorktreeHandle): Promise<void> {
  try {
    await git(projectPath, ["worktree", "remove", "--force", handle.path]);
  } catch {
    // ignore
  }
  try {
    await git(projectPath, ["branch", "-D", handle.branch]);
  } catch {
    // ignore
  }
  try {
    await rm(handle.path, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Удалить integration-worktree (после accept или при cleanup). Ветку оставляем до accept. */
export async function removeIntegrationWorktree(
  projectPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    await git(projectPath, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // ignore
  }
  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Финальная приёмка: fast-forward main → integration.
 * Вызывается по `ai-task --accept <task>` (PLAN §4.5.5) — это явное действие
 * пользователя, поэтому допустимо переключить ветку в основном репо.
 *
 * Шаги:
 *   1. Проверить, что target — предок integration (fast-forward возможен).
 *   2. checkout target в основном репо (если working tree чистый).
 *   3. merge --ff-only integration.
 *   4. Cleanup integration worktree + ветка.
 *
 * Если working tree грязный — отказ (пользователь должен сам разобраться).
 */
export async function acceptTask(
  projectPath: string,
  taskId: string,
  target?: string,
): Promise<{ ok: boolean; message: string }> {
  // review #8 (review-2026-07-13): target по умолчанию — текущая ветка репо,
  // а не хардкод "main" (машина с master/develop падала на merge --ff-only main).
  const targetRef = target ?? (await detectBaseRef(projectPath));
  const integration = integrationBranch(taskId);
  try {
    // 1. fast-forward возможен?
    try {
      await git(projectPath, ["merge-base", "--is-ancestor", targetRef, integration]);
    } catch {
      throw new Error(
        `not fast-forward: '${targetRef}' is not an ancestor of '${integration}'. ` +
          `Integration diverged — manual merge required.`,
      );
    }

    // 2. текущая ветка
    const { stdout: curBranch } = await git(projectPath, ["branch", "--show-current"]);
    const current = curBranch.trim();

    // 3. если не на target — попробовать checkout (требует чистого WT)
    if (current !== targetRef) {
      try {
        await git(projectPath, ["checkout", targetRef]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `cannot checkout '${targetRef}' (working tree dirty?). Clean or stash changes first.\n${msg}`,
        );
      }
    }

    // 4. merge --ff-only
    const { stdout } = await git(projectPath, ["merge", "--ff-only", integration]);

    // 5. Cleanup: удалить integration-ветку и её worktree (review #12).
    //    Ранее cleanup был только в комментарии, но не выполнялся — ветки
    //    orch/<id>/integration копились после каждого accept. Ошибка cleanup
    //    НЕ отменяет уже выполненный merge (сообщение вернётся, но ok=true).
    try {
      await cleanupTask(projectPath, taskId);
    } catch (cleanupErr) {
      // Не перезаписываем успешный merge. Возвращаем ok=true, но с предупреждением.
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      return {
        ok: true,
        message: `${stdout}\n[warn: merge succeeded but cleanup failed: ${cleanupMsg}]`,
      };
    }

    return { ok: true, message: stdout };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

/**
 * Полный cleanup задачи: удалить integration-ветку и её worktree.
 *
 * Если worktreePath не задан — ищем зарегистрированный worktree по ветке
 * через `git worktree list` (after accept путь уже не у всех в памяти).
 * Ошибки удаления логируем, но не бросаем — это best-effort cleanup.
 *
 * review #12: ранее был мёртвым кодом (defined but never called),
 * integration-ветки и worktrees копились. Теперь вызывается из acceptTask
 * и из точек терминального статуса в runner.
 */
export async function cleanupTask(
  projectPath: string,
  taskId: string,
  worktreePath?: string,
): Promise<void> {
  const branch = integrationBranch(taskId);
  // 1. Найти и удалить worktree integration-ветки (если не передан явно).
  let wtToRemove = worktreePath;
  if (!wtToRemove) {
    try {
      wtToRemove = await findWorktreeForBranch(projectPath, branch);
    } catch {
      // best-effort
    }
  }
  if (wtToRemove) {
    try {
      await removeIntegrationWorktree(projectPath, wtToRemove);
    } catch {
      // ignore — ветка важнее
    }
  }
  // 2. Подчистить административные записи worktrees (orphaned после rm -rf).
  try {
    await git(projectPath, ["worktree", "prune"]);
  } catch {
    // ignore
  }
  // 3. Удалить integration-ветку.
  try {
    await git(projectPath, ["branch", "-D", branch]);
  } catch {
    // ignore — ветки может уже не быть (failed task без setupIntegration)
  }
}

/**
 * Найти путь worktree, который отслеживает данную ветку, через `git worktree list`.
 * Возвращает undefined, если такого worktree нет.
 */
async function findWorktreeForBranch(
  projectPath: string,
  branch: string,
): Promise<string | undefined> {
  const { stdout } = await git(projectPath, ["worktree", "list", "--porcelain"]);
  // Формат: блоки "worktree <path>\nHEAD <sha>\nbranch refs/heads/<branch>\n\n".
  let curPath: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      curPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && curPath) {
      const ref = line.slice("branch ".length).trim();
      if (ref === `refs/heads/${branch}` || ref === branch) return curPath;
    }
  }
  return undefined;
}

// ─── Fan-out candidate lifecycle (Task 10, Phase B) ─────────────────────────
//
// Phase B мержит implement-ветки ПОСЛЕДОВАТЕЛЬНО (чтобы не было гонки за HEAD
// integration). Для каждой подзадачи создаётся disposable candidate-ветка от
// текущей integration, туда мержится implement-ветка, там идёт codex-review,
// и ТОЛЬКО при APPROVE candidate продвигается в integration (ff). При REJECT /
// REQUEST_CHANGES / out-of-scope candidate выбрасывается.

/**
 * Создать disposable candidate-ветку + worktree от текущей integration.
 * Для фазы B fan-out: туда мержится одна implement-ветка, там идёт review,
 * и только при APPROVE candidate продвигается в integration.
 *
 * ВАЖНО: ни одна операция здесь не делает `git checkout` в основном репо —
 * ветка создаётся через `git branch`, worktree — через `git worktree add`.
 */
export async function createCandidateWorktree(
  projectPath: string,
  taskId: string,
  subtaskId: string,
): Promise<{ branch: string; worktreePath: string }> {
  const integration = integrationBranch(taskId);
  const branch = `orch/${taskId}/cand-${subtaskId}`;
  const wtPath = await mkdtemp(join(tmpdir(), `orch-${taskId}-cand-${subtaskId}-`));
  // Ветка от текущей integration (для ff-продвижения без конфликтов).
  try {
    await git(projectPath, ["branch", branch, integration]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists|exists/.test(msg)) throw e;
  }
  // НЕ --detach: worktree отслеживает candidate-ветку, чтобы коммиты ревьюера
  // (если ревьюер правит код) и merge-коммит ушли в candidate, а не в detached HEAD.
  await git(projectPath, ["worktree", "add", wtPath, branch]);
  return { branch, worktreePath: wtPath };
}

/**
 * Продвинуть candidate в integration: ff integration → candidate, затем cleanup
 * candidate worktree + ветки. Вызывается ТОЛЬКО при APPROVE из Phase B.
 *
 * РЕАЛИЗАЦИЯ: integration живёт в собственном worktree (его создаёт и держит
 * открытым setupIntegration на протяжении всей задачи). Git РАЗРЕШАЕТ
 * force-update ветки через `branch -f`, но ЗАПРЕЩАЕТ это делать, если ветка
 * checked out в любом worktree — а integration именно такова. Поэтому
 * `branch -f` ВАЛИТСЯ в реальном раннере. (Раньше smoke давал ложную
 * уверенность: он не создавал integration-worktree.)
 *
 * Правильный путь — продвигать integration ЧЕРЕЗ её worktree: HEAD этого
 * worktree = integration-ветка, а candidate — её потомок (создан от integration,
 * только добавляет коммиты), значит `merge --ff-only` валиден и продвигает
 * integration без `git checkout`. Никакого `branch -f`.
 *
 * Cleanup candidate worktree + ветки идёт ПОСЛЕ успешного ff — если ff падает,
 * candidate НЕ зачищается (вызывающий при ошибке может его разобрать), но т.к.
 * candidate-merge уже случился, утечки worktree/ветки не возникает: ветка
 * candidate остаётся, но она одноразовая и задача в целом уходит в HITL.
 *
 * @param integrationWtPath путь к worktree integration-ветки (от setupIntegration)
 */
export async function promoteCandidateToIntegration(
  projectPath: string,
  taskId: string,
  candidate: { branch: string; worktreePath: string },
  integrationWtPath: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    // integration-worktree имеет HEAD = integration; ff-merge candidate продвигает
    // integration (candidate — потомок integration, ff валиден) без checkout.
    await git(integrationWtPath, ["merge", "--ff-only", candidate.branch]);
    // Cleanup candidate worktree + ветка.
    await git(projectPath, ["worktree", "remove", "--force", candidate.worktreePath]).catch(() => {});
    await rm(candidate.worktreePath, { recursive: true, force: true }).catch(() => {});
    await git(projectPath, ["branch", "-D", candidate.branch]).catch(() => {});
    return { ok: true, message: `integration fast-forwarded to ${candidate.branch.slice(-12)}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Удалить disposable candidate (без продвижения) — при REJECT / REQUEST_CHANGES
 * / out-of-scope diff. Cleanup worktree + ветки.
 */
export async function discardCandidate(
  projectPath: string,
  candidate: { branch: string; worktreePath: string },
): Promise<void> {
  await git(projectPath, ["worktree", "remove", "--force", candidate.worktreePath]).catch(() => {});
  await rm(candidate.worktreePath, { recursive: true, force: true }).catch(() => {});
  await git(projectPath, ["branch", "-D", candidate.branch]).catch(() => {});
}
