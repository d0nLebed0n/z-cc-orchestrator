import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Путь к шаблонам (коммитятся в репо). */
export const TEMPLATES_DIR = join(__dirname, "templates");

/**
 * Скопировать скелет директории знаний из templates/ в knowledgeDir.
 * Рекурсивное копирование. Если knowledgeDir уже существует — не падает
 * (cp с recursive:true мержит).
 */
export async function copySkeleton(knowledgeDir: string): Promise<void> {
  if (!existsSync(TEMPLATES_DIR)) {
    throw new Error(`Templates directory not found: ${TEMPLATES_DIR}`);
  }
  await mkdir(knowledgeDir, { recursive: true });
  await cp(TEMPLATES_DIR, knowledgeDir, { recursive: true });
}

