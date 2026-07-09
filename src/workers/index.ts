/**
 * Диспетчер воркеров: по имени агента → функция запуска.
 * PLAN §2.3.
 */
import type { AgentName } from "../families.ts";
import type { WorkerFn } from "./types.ts";
import { runClaude } from "./runClaude.ts";
import { runCodex } from "./runCodex.ts";
import { runGlm } from "./runGlm.ts";
import { runOllama } from "./runOllama.ts";

export const WORKERS: Record<AgentName, WorkerFn> = {
  claude: runClaude,
  codex: runCodex,
  glm: runGlm,
  ollama: runOllama,
};

export function getWorker(agent: AgentName): WorkerFn {
  const w = WORKERS[agent];
  if (!w) throw new Error(`Unknown agent: ${agent}`);
  return w;
}

export { runClaude, runCodex, runGlm, runOllama };
export type { WorkerFn, WorkerResult, WorkerRunOptions } from "./types.ts";
