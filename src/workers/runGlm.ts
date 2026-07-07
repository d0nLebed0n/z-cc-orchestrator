/**
 * runGlm — headless-обёртка над `claude` с env подменой под Z.ai GLM.
 * PLAN §2, §2.3.
 *
 * Если GLM-gate (Этап 0.0) пройден — это просто runClaude с env:
 *   ANTHROPIC_BASE_URL=<z.ai endpoint>
 *   ANTHROPIC_API_KEY=<z.ai key>
 *
 * Если gate провален — сюда подменяется отдельный адаптер (TBD, см. docs/decisions.md).
 * До фиксации gate-env — требует, чтобы env содержал оба ключа (см. ensureGlmEnv).
 */
import type { TaskEnvelope } from "../envelope.ts";
import type { WorkerFn } from "./types.ts";
import { runClaude } from "./runClaude.ts";

const REQUIRED_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"] as const;

function ensureGlmEnv(env: Record<string, string>): void {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `runGlm: missing env for GLM-via-claude: ${missing.join(", ")}. ` +
        `Provide them in opts.env (or run GLM-gate first, see docs/decisions.md).`,
    );
  }
}

export const runGlm: WorkerFn = async (envelope, opts) => {
  const glmEnv: Record<string, string> = {
    ...opts.env,
    // GLM-профиль: подмена эндпоинта и ключа на Z.ai.
    // Значения передаются через opts.env (раннер берёт их из конфига/.env).
  };
  ensureGlmEnv(glmEnv);

  // Технически тот же claude-воркер, но env указывает на Z.ai.
  // Семья определяется в envelope.family ("zai"), а не по бинарнику.
  return runClaude(envelope, { ...opts, env: glmEnv });
};

export default runGlm;
