import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { knowledgeDirFor } from "./registry.ts";
import type { Role } from "../envelope.ts";

/**
 * Файлы, которые могут понадобиться инъекции (union по всем ролям).
 * Читаются один раз в начале runWorkflow — immutable кэш на прогон.
 * active-task сюда НЕ входит (он — переменная в runWorkflow).
 */
const CACHE_FILES = [
  "00-project/product.md",
  "00-project/architecture.md",
  "00-project/code-map.md",
  "00-project/glossary.md",
  "00-project/stack-rules.md",
  "05-context/file-allowlist.md",
  "05-context/file-blocklist.md",
  "05-context/naming-rules.md",
  "05-context/done-definition.md",
];

export type ContextCache = Map<string, string>;

/**
 * Прочитать все файлы контекста в кэш (один раз за прогон).
 * Пропускает отсутствующие. Возвращает пустой Map если директории нет.
 */
export async function loadProjectContextCache(slug: string): Promise<ContextCache> {
  const cache: ContextCache = new Map();
  const dir = knowledgeDirFor(slug);
  if (!existsSync(dir)) return cache;
  for (const rel of CACHE_FILES) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    try {
      const content = await readFile(abs, "utf8");
      // Пропускаем пустые/только-заглушки: если контент < 10 символов или
      // состоит только из комментария/`(none yet)` — не инъектируем.
      const trimmed = content.trim();
      if (trimmed.length < 10) continue;
      if (/^\(none yet\)$/.test(trimmed)) continue;
      cache.set(rel, content);
    } catch {
      // файл пропал между existsSync и readFile — пропускаем
    }
  }
  return cache;
}

/**
 * Секции для каждой роли в порядке приоритета.
 * active-task отмечен как "$ACTIVE_TASK" — подставляется из переменной, не из кэша.
 */
const ROLE_SECTIONS: Record<Role, string[]> = {
  plan: [
    "00-project/architecture.md",
    "00-project/code-map.md",
    "00-project/glossary.md",
    "$ACTIVE_TASK",
  ],
  implement: [
    "00-project/code-map.md",
    "00-project/stack-rules.md",
    "05-context/file-allowlist.md",
    "05-context/file-blocklist.md",
    "05-context/naming-rules.md",
  ],
  refine: [
    "00-project/code-map.md",
    "00-project/stack-rules.md",
    "05-context/file-allowlist.md",
    "05-context/file-blocklist.md",
    "05-context/naming-rules.md",
  ],
  fix: [
    "00-project/code-map.md",
    "00-project/stack-rules.md",
    "05-context/done-definition.md",
    "05-context/file-blocklist.md",
  ],
  review: [
    "00-project/code-map.md",
    "05-context/done-definition.md",
    "05-context/file-allowlist.md",
  ],
  final: [
    "$ACTIVE_TASK",
    "05-context/done-definition.md",
  ],
  architect: [],
};

const MAX_CONTEXT_CHARS = 6000;

/**
 * Обрезать текст по границе: сначала \n\n (абзац), потом \n (строка),
 * потом по символу. Возвращает обрезанный текст + маркер усечения.
 */
function truncateAt(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // 1. Граница абзаца (\n\n)
  let cut = text.lastIndexOf("\n\n", maxLen);
  if (cut > maxLen * 0.5) return text.slice(0, cut) + "\n…[truncated]";
  // 2. Граница строки (\n)
  cut = text.lastIndexOf("\n", maxLen);
  if (cut > maxLen * 0.5) return text.slice(0, cut) + "\n…[truncated]";
  // 3. По символу
  return text.slice(0, maxLen) + "…[truncated]";
}

/**
 * Собрать контекст проекта для роли из кэша + activeTask.
 * Чистая функция над данными в памяти (не читает диск).
 * Возвращает null если контекста нет (деградация).
 */
export function buildProjectContext(
  role: Role,
  cache: ContextCache,
  activeTask: string | null,
): string | null {
  const sections = ROLE_SECTIONS[role];
  if (sections.length === 0) return null; // architect — не инъектируется

  const parts: string[] = [];
  let used = 0;
  for (const rel of sections) {
    let content: string | null = null;
    let label: string;
    if (rel === "$ACTIVE_TASK") {
      if (!activeTask) continue;
      content = activeTask;
      label = "active-task";
    } else {
      content = cache.get(rel) ?? null;
      if (!content) continue;
      label = rel;
    }
    const available = MAX_CONTEXT_CHARS - used;
    if (available <= 0) break;
    // Заголовок секции + контент
    const header = `### ${label}\n`;
    if (header.length + content.length <= available) {
      // Влезает целиком
      parts.push(header + content);
      used += header.length + content.length + 2; // +2 для \n\n
    } else {
      // Не влезает целиком — обрезаем по границе. Если после обрезки
      // остаётся < 100 символов — drop whole (не добавляем обрубок).
      const spaceForContent = available - header.length - 2;
      if (spaceForContent < 100) break; // drop whole, и остальные тоже
      const truncated = truncateAt(content, spaceForContent);
      parts.push(header + truncated);
      used = MAX_CONTEXT_CHARS; // бюджет исчерпан
      break;
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
