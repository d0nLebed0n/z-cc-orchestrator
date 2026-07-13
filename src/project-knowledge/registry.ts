import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Mutex } from "async-mutex";
import { slugFromPath } from "./slug.ts";
import { atomicWrite } from "../lib/atomic-write.ts";

/** Корень централизованного хранилища знаний проектов. */
export const PROJECTS_ROOT = join(homedir(), ".orchestrator", "projects");
export const REGISTRY_FILE = join(homedir(), ".orchestrator", "projects.json");

export type ProjectStatus = "ready" | "generating" | "failed";

export interface ProjectRegistryEntry {
  slug: string;
  projectPath: string;
  createdAt: string;
  lastOpenedAt: string;
  status: ProjectStatus;
  knowledgeDir: string;
  generatorModel?: string;
  lastError?: string;
}

interface ProjectRegistry {
  projects: ProjectRegistryEntry[];
}

const mutex = new Mutex();

/** Путь к директории знаний для slug (без проверки существования). */
export function knowledgeDirFor(slug: string): string {
  return join(PROJECTS_ROOT, slug);
}

/**
 * Прочитать registry. При повреждённом JSON НЕ молчим и не возвращаем пустой
 * список — следующая запись затёрла бы существующие проекты (review #3).
 * Сохраняем повреждённый файл как backup и кидаем явную ошибку.
 */
async function readRegistry(): Promise<ProjectRegistry> {
  if (!existsSync(REGISTRY_FILE)) return { projects: [] };
  const raw = await readFile(REGISTRY_FILE, "utf8");
  try {
    return JSON.parse(raw) as ProjectRegistry;
  } catch (e) {
    const backup = `${REGISTRY_FILE}.corrupt-${Date.now()}`;
    try {
      await atomicWrite(backup, raw);
    } catch {
      // даже backup не удался — не усугубляем
    }
    throw new Error(
      `projects.json is corrupted (saved to ${backup}): ${e instanceof Error ? e.message : e}`,
    );
  }
}

async function writeRegistry(reg: ProjectRegistry): Promise<void> {
  await mkdir(join(homedir(), ".orchestrator"), { recursive: true });
  await atomicWrite(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

/**
 * Найти запись по slug. null если не найдена.
 */
export async function findProject(slug: string): Promise<ProjectRegistryEntry | null> {
  const reg = await readRegistry();
  return reg.projects.find((p) => p.slug === slug) ?? null;
}

/**
 * Найти запись по пути проекта (учитывает коллизии: сначала baseSlug, потом с хэшем).
 */
async function findByPath(projectPath: string): Promise<ProjectRegistryEntry | null> {
  const reg = await readRegistry();
  return reg.projects.find((p) => p.projectPath === projectPath) ?? null;
}

/**
 * Получить или создать запись проекта. Создаёт скелет директории знаний при
 * первом обращении. При коллизии baseSlug (другой путь с тем же basename)
 * добавляет хэш-суффикс.
 *
 * Возвращает entry. Если проект новый — status="generating" (architect ещё не
 * запускался). Если существующий — обновляет lastOpenedAt.
 */
export async function getOrCreateProject(projectPath: string): Promise<ProjectRegistryEntry> {
  return mutex.runExclusive(async () => {
    // Сначала ищем существующую запись по точному пути.
    const existing = await findByPath(projectPath);
    if (existing) {
      existing.lastOpenedAt = new Date().toISOString();
      const reg = await readRegistry();
      const idx = reg.projects.findIndex((p) => p.slug === existing.slug);
      if (idx !== -1) reg.projects[idx] = existing;
      await writeRegistry(reg);
      return existing;
    }

    // Новый проект: определяем slug с учётом коллизий.
    const reg = await readRegistry();
    let slug = slugFromPath(projectPath, false);
    // Коллизия: другой путь уже занял этот baseSlug → добавляем хэш.
    if (reg.projects.some((p) => p.slug === slug)) {
      slug = slugFromPath(projectPath, true);
    }

    const knowledgeDir = knowledgeDirFor(slug);
    await mkdir(knowledgeDir, { recursive: true });

    const now = new Date().toISOString();
    const entry: ProjectRegistryEntry = {
      slug,
      projectPath,
      createdAt: now,
      lastOpenedAt: now,
      status: "generating",
      knowledgeDir,
    };
    reg.projects.push(entry);
    await writeRegistry(reg);
    return entry;
  });
}

/**
 * Обновить статус проекта (ready/failed) и опционально lastError.
 */
export async function updateProjectStatus(
  slug: string,
  status: ProjectStatus,
  lastError?: string,
): Promise<void> {
  return mutex.runExclusive(async () => {
    const reg = await readRegistry();
    const idx = reg.projects.findIndex((p) => p.slug === slug);
    if (idx === -1) throw new Error(`updateProjectStatus: project '${slug}' not found`);
    reg.projects[idx]!.status = status;
    if (lastError !== undefined) reg.projects[idx]!.lastError = lastError;
    else if (status === "ready") reg.projects[idx]!.lastError = undefined;
    await writeRegistry(reg);
  });
}

/**
 * Список всех известных проектов (для будущего recent-list).
 */
export async function listProjects(): Promise<ProjectRegistryEntry[]> {
  const reg = await readRegistry();
  return reg.projects;
}
