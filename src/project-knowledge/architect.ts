import { writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { knowledgeDirFor } from "./registry.ts";

const ARCHITECT_KEYS = ["product", "architecture", "code_map", "glossary", "stack_rules"] as const;
type ArchitectKey = (typeof ARCHITECT_KEYS)[number];

/** Ожидаемые ключи JSON-вывода архитектора → имя файла. */
const KEY_TO_FILE: Record<ArchitectKey, string> = {
  product: "00-project/product.md",
  architecture: "00-project/architecture.md",
  code_map: "00-project/code-map.md",
  glossary: "00-project/glossary.md",
  stack_rules: "00-project/stack-rules.md",
};

export interface ArchitectResult {
  product: string;
  architecture: string;
  code_map: string;
  glossary: string;
  stack_rules: string;
}

/**
 * Lenient-извлечение ключей из JSON, который не парсится строго (модели часто
 * кладут markdown с ``` и неэкранированными " внутрь значений).
 *
 * Стратегия: для каждого ключа ищем `"key"\s*:\s*"` — начало значения. Конец
 * значения = позиция перед следующим ключом из ARCHITECT_KEYS (или `}` перед
 * концом строки). Затем unescape: `\n` → newline, `\"` → `"`, `\\` → `\`.
 */
// review #63: экспортирована для direct unit-теста unescape-логики.
export function extractKeysLenient(jsonStr: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  // Позиции начал всех ключей.
  const positions: { key: string; start: number }[] = [];
  for (const key of ARCHITECT_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*"`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(jsonStr)) !== null) {
      positions.push({ key, start: m.index + m[0].length });
    }
  }
  if (positions.length === 0) return null;
  positions.sort((a, b) => a.start - b.start);

  for (let i = 0; i < positions.length; i++) {
    const { key, start } = positions[i]!;
    // Конец значения: начало следующего ключа, или последний `}` в строке.
    let end: number;
    if (i + 1 < positions.length) {
      end = positions[i + 1]!.start;
      // Откатываемся до запятой/закрывающей кавычки перед следующим ключом.
      // Ищем `",` или `"` перед end.
      const beforeNext = jsonStr.slice(start, end);
      const lastQuote = beforeNext.lastIndexOf('"');
      if (lastQuote > 0) {
        end = start + lastQuote;
      }
    } else {
      // Последний ключ — берём до последней `}` в строке.
      const lastBrace = jsonStr.lastIndexOf("}");
      end = lastBrace > start ? lastBrace : jsonStr.length;
      // Откатываемся до закрывающей кавычки перед `}`.
      const beforeBrace = jsonStr.slice(start, end);
      const lastQuote = beforeBrace.lastIndexOf('"');
      if (lastQuote > 0) {
        end = start + lastQuote;
      }
    }
    let raw = jsonStr.slice(start, end);
    // Убираем trailing запятую/пробелы если остались.
    raw = raw.replace(/[,}\s]+$/, "");
    // review #63 (review-2026-07-13): unescape одним проходом через replacer.
    // Раньше четыре последовательных .replace декодировали \n/\t/\" ДО коллапса
    // \\ — из-за этого `C:\\newdir` (один обратный слэш + newdir) превращалось
    // в `C:\` + настоящий newline + `ewdir`. Единая функция обрабатывает
    // escape-пары согласованно: видит \\ как пару и оставляет одиночный \,
    // не давая последующему n приклеиться как \n.
    const unescaped = raw.replace(/\\(.)/g, (_m, ch: string) => {
      switch (ch) {
        case "n": return "\n";
        case "t": return "\t";
        case '"': return '"';
        case "\\": return "\\";
        case "/": return "/";
        case "r": return "\r";
        default: return ch; // неизвестная пара — отбрасываем backslash
      }
    });
    result[key] = unescaped;
  }
  return result;
}

/**
 * Распарсить вывод архитектора в структуру.
 * Переваривает: голый JSON, JSON в ```json fence, лишний текст вокруг,
 * markdown с code-fences и неэкранированными кавычками внутри JSON-значений.
 * Возвращает null если нет ни одного ожидаемого ключа.
 */
export function parseArchitectJson(output: string): ArchitectResult | null {
  // 1. Попытка вытащить JSON из fence ```json ... ```.
  // ВАЖНО: используем greedy-поиск последнего ```, т.к. внутри JSON-значений
  // могут быть markdown code-fences (```), и non-greedy обрежет JSON на первом
  // внутреннем ```.
  let jsonStr: string | null = null;
  const fenceStart = output.match(/```(?:json)?\s*\n?/);
  if (fenceStart) {
    const lastFenceEnd = output.lastIndexOf("```");
    if (lastFenceEnd > fenceStart.index! + fenceStart[0].length) {
      jsonStr = output.slice(fenceStart.index! + fenceStart[0].length, lastFenceEnd).trim();
    }
  }
  if (!jsonStr) {
    // 2. Попытка найти первый { и последний } (голый JSON, возможно с текстом вокруг)
    const firstBrace = output.indexOf("{");
    const lastBrace = output.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = output.slice(firstBrace, lastBrace + 1);
    }
  }
  if (!jsonStr) return null;

  // 3. Сначала пробуем строгий JSON.parse (работает для well-formed вывода).
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // 4. Fallback: модели часто кладут markdown с code-fences (```) и
    // неэкранированными кавычками внутрь JSON-значений, ломая JSON.parse.
    // Извлекаем каждый ключ отдельно: ищем "key": " и берём всё до
    // следующего "key": или до закрывающей }.
    parsed = extractKeysLenient(jsonStr);
  }

  if (!parsed) return null;

  // Проверяем, что есть хотя бы один ожидаемый ключ.
  const result: Partial<ArchitectResult> = {};
  let found = 0;
  for (const key of ARCHITECT_KEYS) {
    const val = parsed[key];
    if (typeof val === "string" && val.trim().length > 0) {
      result[key] = val;
      found++;
    }
  }
  if (found === 0) return null;
  // Заполняем отсутствующие ключи заглушкой
  for (const key of ARCHITECT_KEYS) {
    if (!(key in result)) {
      result[key] = `<!-- ${key}: not generated by architect -->`;
    }
  }
  return result as ArchitectResult;
}

/**
 * Записать распарсенный результат архитектора в 00-project/*.md.
 */
export async function writeProjectFiles(slug: string, parsed: ArchitectResult): Promise<void> {
  const dir = knowledgeDirFor(slug);
  const projectDir = join(dir, "00-project");
  await mkdir(projectDir, { recursive: true });
  for (const key of ARCHITECT_KEYS) {
    const file = KEY_TO_FILE[key];
    const content = parsed[key];
    await writeFile(join(dir, file), content, "utf8");
  }
}

/**
 * Просканировать структуру проекта для контекста архитектора.
 * Возвращает строку с ls корня, package.json/README (если есть), tree -L 2.
 * Это единственная роль, где context = live-скан, а не директория знаний.
 */
export async function scanProjectStructure(projectPath: string): Promise<string> {
  const parts: string[] = [];

  // 1. Listing корня
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    const listing = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => `${e.isDirectory() ? "[D]" : "[F]"} ${e.name}`)
      .join("\n");
    parts.push(`ROOT LISTING:\n${listing}`);
  } catch {
    parts.push("ROOT LISTING: (unable to read)");
  }

  // 2. package.json (если есть)
  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      parts.push(
        `PACKAGE.JSON:\n${JSON.stringify({
          name: pkg.name,
          version: pkg.version,
          type: pkg.type,
          scripts: pkg.scripts,
          dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
          devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : [],
        }, null, 2)}`,
      );
    } catch {
      parts.push("PACKAGE.JSON: (unparseable)");
    }
  }

  // 3. README (первые 2000 символов)
  for (const readmeName of ["README.md", "README.txt", "README"]) {
    const readmePath = join(projectPath, readmeName);
    if (existsSync(readmePath)) {
      try {
        const content = await readFile(readmePath, "utf8");
        parts.push(`README (${readmeName}):\n${content.slice(0, 2000)}`);
      } catch {
        // skip
      }
      break;
    }
  }

  // 4. Дерево поддиректорий (глубина 2, без node_modules/.git)
  try {
    const tree = await buildTree(projectPath, "", 2);
    parts.push(`DIRECTORY TREE:\n${tree}`);
  } catch {
    parts.push("DIRECTORY TREE: (unable to build)");
  }

  return parts.join("\n\n---\n\n");
}

/** Рекурсивно построить дерево директорий (до maxDepth), исключая шум. */
async function buildTree(dir: string, prefix: string, maxDepth: number): Promise<string> {
  if (maxDepth <= 0) return "";
  const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".orchestrator", "__pycache__"]);
  let result = "";
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const visible = entries
      .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const e of visible) {
      result += `${prefix}${e.isDirectory() ? "[" + e.name + "]" : e.name}\n`;
      if (e.isDirectory()) {
        result += await buildTree(join(dir, e.name), prefix + "  ", maxDepth - 1);
      }
    }
  } catch {
    // permission denied etc
  }
  return result;
}
