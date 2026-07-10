/**
 * Инструменты для tool-loop воркера ollama. Модель (Unsloth-квант) не отдаёт
 * нативный tool_calls — она встраивает <tools>{...}</tools> в content.
 * Парсим этот текстовый протокол, исполняем относительно worktree (cwd).
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";

export interface ToolCall {
  name: "read_file" | "write_file" | "list_dir" | string;
  args: Record<string, string>;
}

/**
 * Достать tool-вызовы из content модели. 30B-модель (Unsloth-квант) крайне
 * нестабильна в формате: наблюдались варианты —
 *   <tools>{"name":"write_file","arguments":{...}}</tools>      (канон)
 *   ```typescript\nwrite_file\n{"path":"...","content":"..."}\n``` (fenced, имя=1-я строка)
 *   ```json\n{"name":"write_file","arguments":{...}}\n```          (fenced JSON с name)
 *   голый {"name":"write_file","arguments":{...}}                  (inline)
 *   {"name":"write_file","arguments":{"file_name":...}}            (file_name вместо path)
 *
 * Стратегия: извлечь ВСЕ кандидаты JSON-объектов из content (из <tools>,
 * из code-fences, и inline), и для каждого проверить, выглядит ли как tool-call
 * (есть name из известного набора + arguments/args/tело). Это надёжнее
 * перечисления форматов — ловит любую обёртку вокруг tool-JSON.
 * Аргументы path/file_path/file_name нормализуются в executeTool.
 */
const KNOWN_TOOLS = new Set(["read_file", "write_file", "list_dir"]);

export function parseToolCalls(content: string): ToolCall[] {
  const out: ToolCall[] = [];
  const seen = new Set<string>(); // дедуп по name+path

  const add = (tc: ToolCall): void => {
    const key = `${tc.name}:${tc.args.path ?? tc.args.file_path ?? tc.args.file_name ?? ""}`;
    if (!seen.has(key)) { seen.add(key); out.push(tc); }
  };

  // 1. <tools>...</tools> — канон: внутри {name, arguments}
  for (const m of content.matchAll(/<tools>\s*([\s\S]*?)\s*<\/tools>/g)) {
    for (const obj of extractJsonObjects(m[1]!)) {
      const tc = asToolCall(obj); if (tc) add(tc);
    }
  }
  // 2. code-fence с именем tool на первой строке: ```lang\nwrite_file\n{args}```
  //    (JSON без name — имя берётся из строки над ним)
  for (const m of content.matchAll(/```[a-zA-Z]*\s*\n\s*(read_file|write_file|list_dir)\s*\n([\s\S]*?)```/g)) {
    const name = m[1]!;
    const body = m[2]!.trim();
    const obj = tryParseJson(body);
    if (obj && typeof obj === "object") {
      add({ name, args: obj as Record<string, string> });
    }
  }
  // 3. code-fence с JSON {name, arguments} внутри (```json\n{...}\n```)
  for (const m of content.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)) {
    for (const obj of extractJsonObjects(m[1]!)) {
      const tc = asToolCall(obj); if (tc) add(tc);
    }
  }
  // 4. JS-call стиль: write_file({...}) / read_file({...}) — модель иногда
  //    вызывает tool как функцию. Извлекаем JSON из скобок.
  for (const m of content.matchAll(/\b(read_file|write_file|list_dir)\s*\(\s*(\{[\s\S]*?\})\s*\)/g)) {
    const name = m[1]!;
    const obj = tryParseJson(m[2]!);
    if (obj && typeof obj === "object") {
      // В этой форме у JSON нет name — args = само тело.
      add({ name, args: { ...(obj as Record<string, string>) } });
    }
  }
  // 5. inline — весь content (найдёт голые {name, arguments} без обёртки)
  for (const obj of extractJsonObjects(content)) {
    const tc = asToolCall(obj); if (tc) add(tc);
  }
  return out;
}

/** Попытаться спарсить JSON, вернуть null при провале. */
function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); }
  catch {
    try { return JSON.parse(s.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]")); }
    catch { return null; }
  }
}

/**
 * Найти все сбалансированные JSON-объекты { ... } в строке (включая вложенные).
 * Возвращает распарсенные значения. Пропускает некорректные.
 */
function extractJsonObjects(s: string): unknown[] {
  const results: unknown[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    // Найти парную закрывающую скобку с учётом вложенности и строк.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            const candidate = s.slice(i, j + 1);
            try {
              results.push(JSON.parse(candidate));
            } catch {
              // не JSON — пропускаем
            }
            break;
          }
        }
      }
    }
  }
  return results;
}

/** Если объект выглядит как tool-call ({name, arguments|args}) — вернуть ToolCall. */
function asToolCall(obj: unknown): ToolCall | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as { name?: unknown; arguments?: Record<string, string>; args?: Record<string, string> };
  if (typeof o.name !== "string" || !KNOWN_TOOLS.has(o.name)) return null;
  const args = o.arguments ?? o.args ?? {};
  return { name: o.name, args };
}

/** Защищённое разрешение пути: относительный к cwd; reject выхода за cwd. */
export function sanitizePath(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? normalize(p) : normalize(join(cwd, p));
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path '${p}' escapes worktree root ${cwd}`);
  }
  return abs;
}

/** Исполнить один tool-вызов. Возвращает текст-результат для истории диалога. */
export async function executeTool(call: ToolCall, cwd: string): Promise<string> {
  // Модель использует path | file_path | filepath | file_name — нормализуем.
  const rawPath = call.args.path ?? call.args.file_path ?? call.args.filepath ?? call.args.file_name;
  switch (call.name) {
    case "read_file": {
      const path = sanitizePath(cwd, String(rawPath ?? ""));
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        return `(error reading ${rawPath}: ${e instanceof Error ? e.message : e})`;
      }
    }
    case "write_file": {
      const path = sanitizePath(cwd, String(rawPath ?? ""));
      await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
      await writeFile(path, String(call.args.content ?? ""), "utf8");
      return `(wrote ${rawPath}, ${String(call.args.content ?? "").length} bytes)`;
    }
    case "list_dir": {
      const path = sanitizePath(cwd, String(rawPath ?? "."));
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`).join("\n");
      } catch (e) {
        return `(error listing ${rawPath}: ${e instanceof Error ? e.message : e})`;
      }
    }
    default:
      return `(unknown tool: ${call.name})`;
  }
}
