/**
 * Диспетчер воркеров: по имени агента → функция запуска.
 * PLAN §2.3.
 */
import type { AgentName } from "../families.ts";
import type { WorkerFn } from "./types.ts";
import { runClaude } from "./runClaude.ts";
import { runCodex } from "./runCodex.ts";
import { runGlm } from "./runGlm.ts";

export const WORKERS: Record<AgentName, WorkerFn> = {
  claude: runClaude,
  codex: runCodex,
  glm: runGlm,
  // ollama worker (runOllama tool-loop) — реализован в более поздней задаче.
  ollama: async () => {
    throw new Error("runOllama not implemented (later task)");
  },
};

export function getWorker(agent: AgentName): WorkerFn {
  const w = WORKERS[agent];
  if (!w) throw new Error(`Unknown agent: ${agent}`);
  return w;
}

export { runClaude, runCodex, runGlm };
export type { WorkerFn, WorkerResult, WorkerRunOptions } from "./types.ts";
