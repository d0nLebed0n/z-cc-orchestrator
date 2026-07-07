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
  base = "main",
): Promise<{ branch: string; worktreePath: string }> {
  const branch = integrationBranch(taskId);
  const wtPath = await mkdtemp(join(tmpdir(), `orch-${taskId}-integration-`));

  // Если integration-ветка уже есть — пересоздаём worktree на ней.
  try {
    await git(projectPath, ["branch", branch, base]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists|exists/.test(msg)) throw e;
  }

  // worktree, отслеживающий integration-ветку (без --detach).
  await git(projectPath, ["worktree", "add", wtPath, branch]);
  return { branch, worktreePath: wtPath };
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
  target = "main",
): Promise<{ ok: boolean; message: string }> {
  const integration = integrationBranch(taskId);
  try {
    // 1. fast-forward возможен?
    try {
      await git(projectPath, ["merge-base", "--is-ancestor", target, integration]);
    } catch {
      throw new Error(
        `not fast-forward: '${target}' is not an ancestor of '${integration}'. ` +
          `Integration diverged — manual merge required.`,
      );
    }

    // 2. текущая ветка
    const { stdout: curBranch } = await git(projectPath, ["branch", "--show-current"]);
    const current = curBranch.trim();

    // 3. если не на target — попробовать checkout (требует чистого WT)
    if (current !== target) {
      try {
        await git(projectPath, ["checkout", target]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `cannot checkout '${target}' (working tree dirty?). Clean or stash changes first.\n${msg}`,
        );
      }
    }

    // 4. merge --ff-only
    const { stdout } = await git(projectPath, ["merge", "--ff-only", integration]);

    return { ok: true, message: stdout };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

/** Полный cleanup задачи: удалить integration-ветку и её worktree. */
export async function cleanupTask(
  projectPath: string,
  taskId: string,
  worktreePath?: string,
): Promise<void> {
  if (worktreePath) {
    await removeIntegrationWorktree(projectPath, worktreePath);
  }
  try {
    await git(projectPath, ["branch", "-D", integrationBranch(taskId)]);
  } catch {
    // ignore
  }
}
