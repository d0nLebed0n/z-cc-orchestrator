/**
 * Инструменты для tool-loop воркера ollama. Модель (Unsloth-квант) не отдаёт
 * нативный tool_calls — она встраивает <tools>{...}</tools> в content.
 * Парсим этот текстовый протокол, исполняем относительно worktree (cwd).
 */
import { readFile, writeFile, readdir, mkdir, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, dirname } from "node:path";

export interface ToolCall {
  name: "read_file" | "write_file" | "list_dir" | string;
  args: Record<string, string>;
}

/**
 * Нормализовать path-аргумент tool-вызова из любого из алиасов, которые
 * выдают модели (path | file_path | filepath | file_name).
 * review #45 (review-2026-07-13): дедуп read_file в воркерах должен использовать
 * ту же нормализацию, что executeTool — иначе read_file через file_path после
 * read_file через path не дедуплицируется.
 */
export function resolveRawPath(call: ToolCall): string {
  return call.args.path ?? call.args.file_path ?? call.args.filepath ?? call.args.file_name ?? "";
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
    // LLM часто выдаёт сырые newlines/tabs внутри строковых значений (невалидный
    // JSON). Пробуем нормализовать: внутри строк — заменить на escape-последовательности.
    try { return JSON.parse(sanitizeJsonStrings(s)); }
    catch {
      try { return JSON.parse(sanitizeJsonStrings(s).replace(/,\s*}/g, "}").replace(/,\s*]/g, "]")); }
      catch { return null; }
    }
  }
}

/**
 * Заменить сырые control-символы (\n \r \t) внутри строковых литералов JSON на
 * escape-последовательности. Символы ВНЕ строк (между токенами) не трогаем —
 * там newlines валидны. Решает проблему, когда LLM пишет multi-line content
 * прямо в JSON-строке.
 */
function sanitizeJsonStrings(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      // Сырой control-символ внутри строки → escape.
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
      out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  return out;
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
              // Возможно, внутри строк сырые newlines (LLM) — нормализуем.
              try {
                results.push(JSON.parse(sanitizeJsonStrings(candidate)));
              } catch {
                // не JSON — пропускаем
              }
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

/**
 * Защищённое разрешение пути: относительный к cwd; reject выхода за cwd.
 *
 * Лексическая проверка (normalize/relative) НЕ достаточна: symlink внутри
 * worktree может указывать наружу (напр. worktree/config → ~/.ssh/config), и
 *单纯的 lexical check пропустит его (review #2). Поэтому:
 *   - канонизируем корень worktree через realpath (разрешает symlink-корень);
 *   - для существующей цели проверяем её realpath — он должен оставаться внутри корня;
 *   - для нового файла проверяем realpath ближайшего существующего родителя;
 *   - дополнительно отклоняем symlink-компоненту в самом пути через lstat
 *     (защита от symlink-to-dir, чей realpath формально под корнем на момент проверки).
 */
export async function sanitizePath(cwd: string, p: string): Promise<string> {
  // Канонический корень worktree (разрешает symlink, напр. /tmp → /private/tmp на macOS).
  const rootReal = await realpath(cwd);

  const abs = isAbsolute(p) ? normalize(p) : normalize(join(rootReal, p));
  const rel = relative(rootReal, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path '${p}' escapes worktree root ${rootReal}`);
  }

  // Отклонить любую symlink-компоненту внутри worktree (не даём следовать наружу).
  // Проверяем каждый родительский сегмент от корня до целевого пути через lstat.
  await assertNoSymlinkIn(rootReal, abs);

  // Для существующей цели — её realpath должен оставаться внутри корня
  // (защита от symlink, чья ссылка ведёт наружу).
  try {
    const targetReal = await realpath(abs);
    const targetRel = relative(rootReal, targetReal);
    if (targetRel.startsWith("..") || isAbsolute(targetRel)) {
      throw new Error(`path '${p}' resolves outside worktree root via symlink`);
    }
  } catch (e) {
    // ENOENT — целевой файл ещё не существует (write_file нового файла).
    // Проверяем ближайший существующий родитель: если он — symlink наружу, отвергаем.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw e;
    await assertParentInsideRoot(abs, rootReal, p);
  }
  return abs;
}

/** Проверить, что ни один сегмент от root до abs не является symlink. */
async function assertNoSymlinkIn(root: string, abs: string): Promise<void> {
  // От root (включительно) до родителя abs. Сам abs может быть ещё не существующим.
  const segments = abs.slice(root.length).split("/").filter(Boolean);
  let cur = root;
  for (const seg of segments) {
    cur = join(cur, seg);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // дальше пути не существует — ок для нового файла
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`path component '${cur}' is a symlink — refused`);
    }
  }
}

/** Для несуществующей цели: realpath ближайшего существующего родителя внутри root. */
async function assertParentInsideRoot(abs: string, root: string, orig: string): Promise<void> {
  let dir = dirname(abs);
  for (let i = 0; i < 32 && dir !== root && dir !== "/"; i++) {
    try {
      const parentReal = await realpath(dir);
      const rel = relative(root, parentReal);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`path '${orig}' resolves outside worktree root via symlink`);
      }
      return; // нашли существующего родителя, он внутри root
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
      dir = dirname(dir);
    }
  }
}

/** Исполнить один tool-вызов. Возвращает текст-результат для истории диалога. */
export async function executeTool(call: ToolCall, cwd: string): Promise<string> {
  // review #45: нормализация path-алиасов вынесена в resolveRawPath (общий хелпер
  // для executeTool и дедупа read_file в воркерах).
  const rawPath = resolveRawPath(call);
  switch (call.name) {
    case "read_file": {
      let path: string;
      try {
        path = await sanitizePath(cwd, String(rawPath ?? ""));
      } catch (e) {
        return `(error reading ${rawPath}: ${e instanceof Error ? e.message : e})`;
      }
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        return `(error reading ${rawPath}: ${e instanceof Error ? e.message : e})`;
      }
    }
    case "write_file": {
      let path: string;
      try {
        path = await sanitizePath(cwd, String(rawPath ?? ""));
      } catch (e) {
        return `(error writing ${rawPath}: ${e instanceof Error ? e.message : e})`;
      }
      await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
      await writeFile(path, String(call.args.content ?? ""), "utf8");
      return `(wrote ${rawPath}, ${String(call.args.content ?? "").length} bytes)`;
    }
    case "list_dir": {
      let path: string;
      try {
        path = await sanitizePath(cwd, String(rawPath ?? "."));
      } catch (e) {
        return `(error listing ${rawPath}: ${e instanceof Error ? e.message : e})`;
      }
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
