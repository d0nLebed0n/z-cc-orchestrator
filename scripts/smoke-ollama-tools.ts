import { parseToolCalls, executeTool, sanitizePath } from "../src/workers/ollama-tools.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// parse single tool call
let calls = parseToolCalls('<tools>\n{"name":"read_file","arguments":{"path":"a.ts"}}\n</tools>');
assert(calls.length === 1 && calls[0]!.name === "read_file" && calls[0]!.args.path === "a.ts", "parse read_file");

// parse multiple (rare but possible)
calls = parseToolCalls('<tools>{"name":"list_dir","arguments":{"path":"src"}}</tools> text <tools>{"name":"read_file","arguments":{"path":"x"}}</tools>');
assert(calls.length === 2, "parse 2 calls");

// no tools
assert(parseToolCalls("just text").length === 0, "no tools → empty");
assert(parseToolCalls("").length === 0, "empty → empty");

// malformed json → ignored, not crash
calls = parseToolCalls("<tools>not json</tools>");
assert(calls.length === 0, "malformed ignored");

// alt format: markdown-fenced with tool name on first line (30B нестабильность)
calls = parseToolCalls("I'll create the file.\n\n```typescript\nwrite_file\n{\n  \"path\": \"hello.ts\",\n  \"content\": \"export const x = 1;\"\n}\n```\n\nDone.");
assert(calls.length === 1 && calls[0]!.name === "write_file" && calls[0]!.args.path === "hello.ts", "parse fenced write_file (alt format)");
assert(calls[0]!.args.content === "export const x = 1;", "fenced content extracted");

// alt format: file_path instead of path
calls = parseToolCalls("```json\nwrite_file\n{\"file_path\":\"a.ts\",\"content\":\"x\"}\n```");
assert(calls.length === 1 && calls[0]!.name === "write_file", "parse fenced with file_path");

// alt format: inline JSON with name+arguments (no tags/fences)
calls = parseToolCalls('Here: {"name":"read_file","arguments":{"path":"b.ts"}} done');
assert(calls.length === 1 && calls[0]!.name === "read_file" && calls[0]!.args.path === "b.ts", "parse inline JSON tool call");

// alt format: fenced JSON with {name, arguments} (```json\n{...}\n```) + file_name
calls = parseToolCalls('```json\n{\n  "name": "write_file",\n  "arguments": {\n    "file_name": "hello.ts",\n    "content": "export const x = 1;"\n  }\n}\n```');
assert(calls.length === 1 && calls[0]!.name === "write_file", "parse fenced JSON with name+arguments");
assert(calls[0]!.args.file_name === "hello.ts", "fenced JSON: file_name arg captured");

// alt format: JS-call style write_file({...}) — модель иногда зовёт tool как функцию
calls = parseToolCalls('write_file({\n  "path": "hello.ts",\n  "content": "export const x = 1;"\n})');
assert(calls.length === 1 && calls[0]!.name === "write_file" && calls[0]!.args.path === "hello.ts", "parse JS-call write_file({...})");

// path sanitize
assert(sanitizePath(join("/root"), "src/a.ts") === join("/root", "src/a.ts"), "relative joined");
assert(sanitizePath(join("/root"), "/root/src/a.ts") === join("/root", "src/a.ts"), "absolute under root ok");
let threw = false;
try { sanitizePath(join("/root"), "../etc/passwd"); } catch { threw = true; }
assert(threw, "../ escape rejected");
threw = false;
try { sanitizePath(join("/root"), "/etc/passwd"); } catch { threw = true; }
assert(threw, "absolute outside root rejected");

// execute: read + write + list
const root = mkdtempSync(join(tmpdir(), "ollama-tools-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.ts"), "export const x = 1;");
const r1 = await executeTool({ name: "read_file", args: { path: "src/a.ts" } }, root);
assert(r1.includes("export const x = 1;"), "read_file returns content");
await executeTool({ name: "write_file", args: { path: "src/b.ts", content: "export const y = 2;" } }, root);
const r3 = await executeTool({ name: "list_dir", args: { path: "src" } }, root);
assert(r3.includes("a.ts") && r3.includes("b.ts"), "list_dir shows both");
const unknown = await executeTool({ name: "nope", args: {} }, root);
assert(unknown.includes("unknown tool"), "unknown tool reported");
rmSync(root, { recursive: true, force: true });

console.log("\nAll ollama-tools checks passed.");
