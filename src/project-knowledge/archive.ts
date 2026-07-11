import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { knowledgeDirFor } from "./registry.ts";

/**
 * Архивировать завершённую задачу: дописать блок в decisions.md и touched-files.md.
 * touched-files считается через git diff --name-only <baseSha> <integrationTip>.
 * active-task сбрасывается в idle шаблон.
 */
export async function archiveTask(
  slug: string,
  taskId: string,
  prompt: string,
  success: boolean,
  baseSha: string | null,
  changedFiles: string[],
): Promise<void> {
  const dir = knowledgeDirFor(slug);
  if (!existsSync(dir)) return; // директории знаний нет — не архивируем

  const outputDir = join(dir, "07-output");
  await mkdir(outputDir, { recursive: true });
  const now = new Date().toISOString();
  const verdict = success ? "SUCCESS" : "FAILED";

  // decisions.md — append
  const decisionBlock = [
    "",
    `## ${taskId} — ${now} — ${verdict}`,
    `Prompt: ${prompt.slice(0, 200)}`,
    `Files changed: ${changedFiles.length}`,
    "",
  ].join("\n");
  await appendFile(join(outputDir, "decisions.md"), decisionBlock, "utf8");

  // touched-files.md — append
  const filesBlock = [
    "",
    `## ${taskId} — ${now}`,
    ...changedFiles.map((f) => `- ${f}`),
    "",
  ].join("\n");
  await appendFile(join(outputDir, "touched-files.md"), filesBlock, "utf8");

  // active-task.md — reset to idle
  const idleContent = [
    "# Active Task",
    "status: idle",
    `updated: ${now}`,
    "",
    "## Goal",
    "",
    "## Scope",
    "- target_paths: none",
    "",
    "## Acceptance Criteria",
    "",
    "## Notes",
    "",
  ].join("\n");
  await mkdir(join(dir, "03-tasks"), { recursive: true });
  await writeFile(join(dir, "03-tasks", "active-task.md"), idleContent, "utf8");
}
