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
 * Достать tool-вызовы из content модели. 30B-модель (Unsloth-квант) нестабильна
 * в формате: иногда правильный <tools>{json}</tools>, иногда markdown-fenced
 * с именем tool отдельной строкой, иногда голый JSON. Покрываем все варианты.
 * Malformed — пропускаем (не падаем).
 *
 * Поддержанные формы:
 *  1. <tools>{"name":"write_file","arguments":{...}}</tools>  (канон)
 *  2. ```lang\nwrite_file\n{"path":"...","content":"..."}\n```  (fenced, имя=1-я строка)
 *  3. голый {"name":"write_file","arguments":{...}}  (inline JSON)
 * Аргументы: arguments | args | само тело (для формы 2). path/file_path нормализуются
 * в executeTool.
 */
export function parseToolCalls(content: string): ToolCall[] {
  const out: ToolCall[] = [];
  const known = new Set(["read_file", "write_file", "list_dir"]);

  // 1. <tools>{json}</tools>
  const reTools = /<tools>\s*(\{[\s\S]*?\})\s*<\/tools>/g;
  let m: RegExpExecArray | null;
  while ((m = reTools.exec(content)) !== null) {
    pushFromJson(out, m[1]!);
  }

  // 2. ```...\n<toolname>\n{json}\n``` — имя tool первой строкой блока.
  const reFence = /```[a-zA-Z]*\s*\n\s*(read_file|write_file|list_dir)\s*\n([\s\S]*?)```/g;
  while ((m = reFence.exec(content)) !== null) {
    const name = m[1]!;
    const body = m[2]!.trim();
    const obj = tryParseJson(body);
    if (obj && typeof obj === "object") {
      out.push({ name, args: obj as Record<string, string> });
    }
  }

  // 3. голый {"name":"<tool>","arguments":{...}} (без fences/тегов)
  if (out.length === 0) {
    const reInline = /\{\s*"name"\s*:\s*"(read_file|write_file|list_dir)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})[^}]*\}/g;
    while ((m = reInline.exec(content)) !== null) {
      const name = m[1]!;
      const obj = tryParseJson(m[2]!);
      if (obj && typeof obj === "object") {
        out.push({ name, args: obj as Record<string, string> });
      }
    }
  }

  return out;
}

/** Попытаться спарсить JSON, вернуть null при провале (не бросать). */
function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Возможно, content содержит экранированные \n как литералы — пробуем ещё раз
    // после удаления trailing запятых/комментариев. Если и так не вышло — null.
    try {
      return JSON.parse(s.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"));
    } catch {
      return null;
    }
  }
}

/** Из JSON-объекта с полями name + arguments|args — собрать ToolCall. */
function pushFromJson(out: ToolCall[], json: string): void {
  const obj = tryParseJson(json);
  if (obj && typeof obj === "object" && typeof (obj as { name?: unknown }).name === "string") {
    const o = obj as { name: string; arguments?: Record<string, string>; args?: Record<string, string> };
    out.push({ name: o.name, args: o.arguments ?? o.args ?? {} });
  }
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
  // Модель использует path | file_path | filepath — нормализуем.
  const rawPath = call.args.path ?? call.args.file_path ?? call.args.filepath;
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
