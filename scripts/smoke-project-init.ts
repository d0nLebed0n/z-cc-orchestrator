/**
 * Smoke-тест: проверяет создание скелета директории знаний + парсинг architect JSON.
 * Не запускает реальную модель (для этого нужен --init-project на реальном проекте).
 * Проверяет: slug, registry, skeleton copy, parseArchitectJson.
 */
import { getOrCreateProject, updateProjectStatus, findProject } from "../src/project-knowledge/registry.ts";
import { copySkeleton } from "../src/project-knowledge/skeleton.ts";
import { slugFromPath } from "../src/project-knowledge/slug.ts";
import { parseArchitectJson, writeProjectFiles, scanProjectStructure } from "../src/project-knowledge/architect.ts";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

async function main(): Promise<void> {
  const testPath = "/tmp/smoke-test-project";
  console.log("=== smoke-project-init ===\n");

  // 1. Slug
  const slug = slugFromPath(testPath);
  console.log(`1. slug: ${slug}`);
  if (slug !== "smoke-test-project") throw new Error(`slug mismatch: ${slug}`);

  // 2. Registry
  const entry = await getOrCreateProject(testPath);
  console.log(`2. registry entry: slug=${entry.slug} status=${entry.status}`);
  if (entry.status !== "generating") throw new Error(`expected generating, got ${entry.status}`);

  // 3. Skeleton
  await copySkeleton(entry.knowledgeDir);
  const hasActive = existsSync(join(entry.knowledgeDir, "03-tasks", "active-task.md"));
  const hasAllowlist = existsSync(join(entry.knowledgeDir, "05-context", "file-allowlist.md"));
  console.log(`3. skeleton: active-task=${hasActive} allowlist=${hasAllowlist}`);
  if (!hasActive || !hasAllowlist) throw new Error("skeleton files missing");

  // 4. parseArchitectJson
  const mockOutput = '```json\n{"product":"test","architecture":"arch","code_map":"map","glossary":"gloss","stack_rules":"rules"}\n```';
  const parsed = parseArchitectJson(mockOutput);
  console.log(`4. parseArchitectJson: product=${parsed?.product}`);
  if (!parsed || parsed.product !== "test") throw new Error("parse failed");

  // 5. writeProjectFiles
  await writeProjectFiles(entry.slug, parsed);
  const hasArch = existsSync(join(entry.knowledgeDir, "00-project", "architecture.md"));
  console.log(`5. writeProjectFiles: architecture.md=${hasArch}`);
  if (!hasArch) throw new Error("writeProjectFiles failed");

  // 6. scanProjectStructure (on orchestrator root itself)
  const scan = await scanProjectStructure(process.cwd());
  console.log(`6. scanProjectStructure: ${scan.length} chars (contains PACKAGE.JSON: ${scan.includes("PACKAGE.JSON")})`);
  if (!scan.includes("PACKAGE.JSON")) throw new Error("scan missed package.json");

  // 7. Status update
  await updateProjectStatus(entry.slug, "ready");
  const updated = await findProject(entry.slug);
  console.log(`7. status update: ${updated?.status}`);
  if (updated?.status !== "ready") throw new Error("status update failed");

  // Cleanup
  await rm(entry.knowledgeDir, { recursive: true, force: true });
  const { readFile, writeFile } = await import("node:fs/promises");
  const regFile = join(homedir(), ".orchestrator", "projects.json");
  const reg = JSON.parse(await readFile(regFile, "utf8"));
  reg.projects = reg.projects.filter((p: { slug: string }) => p.slug !== entry.slug);
  await writeFile(regFile, JSON.stringify(reg, null, 2));

  console.log("\n✓ all smoke checks passed");
}

main().catch((e) => {
  console.error("✗ smoke failed:", e);
  process.exit(1);
});
