import { join, resolve } from "node:path";

/**
 * Конфигурация бэкенда.
 *
 * ORCHESTRATOR_ROOT — корень репо z-cc-orchestrator, где лежат:
 *   src/cli.ts, workflows/, .orchestrator/, package.json.
 * По умолчанию это родитель директории ui-backend.
 */
export const ORCHESTRATOR_ROOT = resolve(
  process.env.ORCHESTRATOR_ROOT ?? join(__dirname, "..", ".."),
);

export const PORT = Number(process.env.PORT ?? 3001);

export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

/** Пути внутри оркестратора. */
export const PATHS = {
  cli: join(ORCHESTRATOR_ROOT, "src", "cli.ts"),
  workflowsDir: join(ORCHESTRATOR_ROOT, "workflows"),
  blackboardDir: join(ORCHESTRATOR_ROOT, ".orchestrator"),
  stateFile: join(ORCHESTRATOR_ROOT, ".orchestrator", "state.json"),
  resultsDir: join(ORCHESTRATOR_ROOT, ".orchestrator", "results"),
} as const;
