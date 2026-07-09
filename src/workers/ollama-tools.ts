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

/** Достать все <tools>{json}</tools> из content модели. Malformed — пропускаем. */
export function parseToolCalls(content: string): ToolCall[] {
  const out: ToolCall[] = [];
  const re = /<tools>\s*(\{[\s\S]*?\})\s*<\/tools>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1]!);
      if (obj && typeof obj === "object" && typeof obj.name === "string") {
        out.push({ name: obj.name, args: obj.arguments ?? obj.args ?? {} });
      }
    } catch {
      // malformed json in this block — skip
    }
  }
  return out;
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
  switch (call.name) {
    case "read_file": {
      const path = sanitizePath(cwd, String(call.args.path ?? ""));
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        return `(error reading ${call.args.path}: ${e instanceof Error ? e.message : e})`;
      }
    }
    case "write_file": {
      const path = sanitizePath(cwd, String(call.args.path ?? ""));
      await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
      await writeFile(path, String(call.args.content ?? ""), "utf8");
      return `(wrote ${call.args.path}, ${String(call.args.content ?? "").length} bytes)`;
    }
    case "list_dir": {
      const path = sanitizePath(cwd, String(call.args.path ?? "."));
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`).join("\n");
      } catch (e) {
        return `(error listing ${call.args.path}: ${e instanceof Error ? e.message : e})`;
      }
    }
    default:
      return `(unknown tool: ${call.name})`;
  }
}
