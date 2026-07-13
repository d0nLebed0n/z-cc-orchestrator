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

/**
 * Хост для app.listen(). По умолчанию — localhost: API запускает агентов над
 * локальными git-репозиториями и не должен быть доступен по сети без аутентификации.
 *
 * Remote-режим (bind на все интерфейсы) включается явно через `HOST=0.0.0.0`.
 * Это небезопасно без дополнительной аутентификации/reverse-proxy —
 * на вашей ответственности.
 */
export const HOST = process.env.HOST ?? "127.0.0.1";

/** Пути внутри оркестратора. */
export const PATHS = {
  cli: join(ORCHESTRATOR_ROOT, "src", "cli.ts"),
  workflowsDir: join(ORCHESTRATOR_ROOT, "workflows"),
  blackboardDir: join(ORCHESTRATOR_ROOT, ".orchestrator"),
  stateFile: join(ORCHESTRATOR_ROOT, ".orchestrator", "state.json"),
  resultsDir: join(ORCHESTRATOR_ROOT, ".orchestrator", "results"),
  modelsConfig: join(ORCHESTRATOR_ROOT, ".orchestrator", "models.yaml"),
  secretsFile: join(ORCHESTRATOR_ROOT, ".orchestrator", ".secrets"),
} as const;
