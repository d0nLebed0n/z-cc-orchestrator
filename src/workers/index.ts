/**
 * Диспетчер воркеров: по модели из реестра → функция запуска.
 * Заменил жёсткий WORKERS-map на runtime-диспетчер по kind модели.
 */
import { getModel, getSecret } from "../model-registry.ts";
import type { TaskEnvelope } from "../envelope.ts";
import type { WorkerFn, WorkerResult, WorkerRunOptions } from "./types.ts";
import { runClaude } from "./runClaude.ts";
import { runCodex } from "./runCodex.ts";
import { runOllama } from "./runOllama.ts";
import { makeRunApiOpenAi } from "./runApiOpenAi.ts";

/**
 * Запустить воркер для модели по её kind. Инжектит env из реестра/секретов.
 */
export async function dispatchWorker(
  modelId: string,
  envelope: TaskEnvelope,
  opts: WorkerRunOptions,
): Promise<WorkerResult> {
  const model = getModel(modelId);
  if (!model) {
    throw new Error(`dispatchWorker: model '${modelId}' not found in registry`);
  }

  switch (model.kind) {
    case "claude-binary":
      return runClaude(envelope, opts);

    case "codex-binary":
      return runCodex(envelope, opts);

    case "api": {
      if (model.provider === "anthropic") {
        const key = getSecret(model.id) ?? "";
        const env: Record<string, string> = {
          ...opts.env,
          ANTHROPIC_BASE_URL: model.base_url ?? "",
          ANTHROPIC_API_KEY: key,
        };
        return runClaude(envelope, { ...opts, env });
      }
      if (model.provider === "openai") {
        const key = getSecret(model.id) ?? "";
        if (!model.base_url || !model.model) {
          throw new Error(`api+openai model '${model.id}' requires base_url and model`);
        }
        const worker = makeRunApiOpenAi(model.base_url, key, model.model);
        return worker(envelope, opts);
      }
      throw new Error(`api model '${model.id}' has unknown provider '${model.provider}'`);
    }

    case "ollama-http": {
      if (!model.base_url || !model.model) {
        throw new Error(`ollama-http model '${model.id}' requires base_url and model`);
      }
      const env: Record<string, string> = {
        ...opts.env,
        OLLAMA_BASE_URL: model.base_url,
        OLLAMA_MODEL: model.model,
      };
      return runOllama(envelope, { ...opts, env });
    }

    default:
      throw new Error(`dispatchWorker: unknown kind '${(model as { kind: string }).kind}'`);
  }
}

export { runClaude, runCodex, runOllama };
export type { WorkerFn, WorkerResult, WorkerRunOptions } from "./types.ts";
