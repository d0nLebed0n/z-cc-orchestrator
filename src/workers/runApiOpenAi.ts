/**
 * runApiOpenAi — HTTP-клиент для OpenAI-compatible /v1/chat/completions.
 * Для kind=api, provider=openai. Tool-loop через ollama-tools (content-embedded).
 */
import type { TaskEnvelope } from "../envelope.ts";
import type { WorkerFn, WorkerResult } from "./types.ts";
import { parseToolCalls, executeTool } from "./ollama-tools.ts";
import { truncate } from "./spawn.ts";

const EDITING_ROLES = new Set(["implement", "refine", "fix"]);

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Создаёт WorkerFn для заданного base_url + api_key + model. */
export function makeRunApiOpenAi(
  baseUrl: string,
  apiKey: string,
  modelName: string,
): WorkerFn {
  async function chat(messages: ChatMessage[], timeoutMs: number): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: modelName,
          messages,
          stream: false,
          temperature: 0,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`api-openai HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }

  const fn: WorkerFn = async (envelope, opts) => {
    const start = Date.now();
    const wallSec = opts.wallTimeSecOverride ?? envelope.budget.wall_time_sec;
    const wallMs = wallSec * 1000;
    const maxIters = envelope.budget.max_steps * 8;
    const needsEdits = EDITING_ROLES.has(envelope.role);

    const messages: ChatMessage[] = [
      { role: "system", content: "You are a coding agent that edits files via tool calls." },
      { role: "user", content: envelope.prompt },
    ];

    let lastAssistant = "";
    let httpOk = true;
    let timedOut = false;
    let iters = 0;

    while (iters < maxIters && Date.now() - start < wallMs) {
      iters++;
      let reply: string;
      try {
        reply = await chat(messages, Math.max(2000, wallMs - (Date.now() - start)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/aborted|timeout/i.test(msg)) timedOut = true;
        httpOk = false;
        lastAssistant = msg;
        break;
      }
      lastAssistant = reply;
      messages.push({ role: "assistant", content: reply });

      const calls = parseToolCalls(reply);
      if (calls.length === 0) break;

      for (const call of calls) {
        try {
          const result = await executeTool(call, opts.cwd);
          messages.push({ role: "tool", content: result });
        } catch (e) {
          messages.push({ role: "tool", content: `(error: ${e instanceof Error ? e.message : e})` });
        }
      }
    }

    const output = truncate(lastAssistant.trim());
    const hasOutput = output.length > 0;
    const signals: WorkerResult["signals"] = [
      { name: "exit_0", ok: httpOk, detail: httpOk ? "http 200" : "http error" },
      { name: "nonempty_output", ok: hasOutput, detail: `${output.length} chars` },
    ];

    let reason: WorkerResult["reason"] = null;
    if (timedOut) reason = "timeout";
    else if (!httpOk) reason = "error";
    else if (!hasOutput) reason = "no_output";

    const success = signals.every((s) => s.ok);
    return {
      exit_ok: httpOk,
      exit_code: httpOk ? 0 : 1,
      output,
      timed_out: timedOut,
      has_output: hasOutput,
      has_changes: null,
      signals,
      success,
      reason,
      stderr: httpOk ? "" : truncate(lastAssistant),
      duration_ms: Date.now() - start,
    };
  };
  return fn;
}
