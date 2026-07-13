import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";
import { existsSync, statSync, realpathSync, type Stats } from "node:fs";

/**
 * Развернуть ~ и ~/... в домашнюю директорию.
 * Node.js не делает этого сам (resolve("~/x") даёт "<cwd>/~/x").
 * Поддерживает только ведущую тильду: ~, ~/foo, ~user (последнее не разворачиваем).
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export type ValidationResult =
  | { ok: true; path: string }
  | { ok: false; reason: "not_found" | "not_dir" | "not_git_repo"; path: string };

/**
 * Проверить, что путь существует, это директория и git-репозиторий.
 * Возвращает развёрнутый абсолютный путь при успехе или понятную причину отказа.
 */
export function validateProjectPath(raw: string): ValidationResult {
  const expanded = expandTilde(raw.trim());
  // resolve от cwd бэкенда (ORCHESTRATOR_ROOT) — но относительные пути
  // к целевому проекту почти всегда бессмысленны, поэтому требуем абсолютный.
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded);

  if (!existsSync(abs)) {
    return { ok: false, reason: "not_found", path: abs };
  }
  let st: Stats;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, reason: "not_found", path: abs };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: "not_dir", path: abs };
  }
  // git-репозиторий: либо .git внутри, либо это сам .git-файл (worktree/submodule).
  const gitDir = join(abs, ".git");
  if (!existsSync(gitDir)) {
    return { ok: false, reason: "not_git_repo", path: abs };
  }
  // Канонизируем через realpath — единый принцип с sanitizePath (review #E):
  // все файловые операции должны держаться внутри канонического корня, иначе
  // symlink на проектный корень даст разные "корни" для валидации и для worktree.
  try {
    const canonical = realpathSync(abs);
    return { ok: true, path: canonical };
  } catch {
    return { ok: false, reason: "not_found", path: abs };
  }
}

/** Человекочитаемое сообщение об ошибке валидации (для фронта/логов). */
export function validationMessage(r: Exclude<ValidationResult, { ok: true }>): string {
  switch (r.reason) {
    case "not_found":
      return `путь не существует: ${r.path}`;
    case "not_dir":
      return `путь должен быть директорией git-репозитория, а не файлом: ${r.path}`;
    case "not_git_repo":
      return `это не git-репозиторий (нет .git): ${r.path}. --project должен указывать на корень git-репозитория.`;
  }
}
