#!/usr/bin/env node
/**
 * ui-health.mjs — запускает `ai-task --health` и показывает результат в читаемом виде.
 * Используется перед стартом UI, чтобы быстро понять, почему задача может упасть
 * (claude/codex не залогинены, GLM-креды отсутствуют).
 *
 * Запуск: npm run ui:health
 * Exit code 0 — всё здорово, ненулевой — есть проблемы.
 */
import { spawn } from "node:child_process";

const child = spawn("npx", ["tsx", "src/cli.ts", "--health"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  if (code === 0) {
    console.log("\n✓ Все агенты здоровы — можно запускать UI (npm run ui:full)");
  } else {
    console.log("\n✗ Есть проблемы с агентами. UI поднимется, но задачи с больными агентами упадут.");
    console.log("  Совет: задачу всё равно можно запустить на воркфлоу, который не использует больной агент.");
  }
  process.exit(code ?? 1);
});
