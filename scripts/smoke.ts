/**
 * Smoke-тест: загрузить все встроенные воркфлоу и проверить валидность
 * (схема, топологическая сортировка, кросс-семейная проверка, loop).
 * Запуск: npx tsx scripts/smoke.ts
 */
import { loadWorkflow } from "../src/runner.ts";

async function main(): Promise<void> {
  const workflows = ["default", "quick", "thorough", "ui", "boilerplate", "agentic"];
  let failures = 0;

  for (const w of workflows) {
    try {
      const loaded = await loadWorkflow(`workflows/${w}.yaml`);
      const loopInfo = loaded.loop
        ? `loop(${loaded.loopBody.length} steps, exit_on=${loaded.loop.exit_on}, max=${loaded.loop.max_iterations})`
        : "no loop";
      console.log(
        `✓ ${w.padEnd(12)} ${loaded.allSteps.length} steps, ${loaded.preLevels.length} pre-levels, ${loopInfo}`,
      );
    } catch (e) {
      failures++;
      console.error(
        `✗ ${w.padEnd(12)} ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Негативный тест: same-family review должен падать.
  const badYaml = `
name: bad
steps:
  - id: impl
    agent: codex
    role: implement
    budget: { wall_time_sec: 100, max_steps: 2 }
    depends_on: []
  - id: rev
    agent: codex
    role: review
    budget: { wall_time_sec: 100, max_steps: 2 }
    depends_on: [impl]
`;
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const tmp = join(process.cwd(), "workflows", "_bad_test.yaml");
  writeFileSync(tmp, badYaml);
  try {
    await loadWorkflow(tmp);
    console.error("✗ bad_test     same-family review NOT rejected (should have thrown)");
    failures++;
  } catch {
    console.log("✓ bad_test     same-family review correctly rejected");
  } finally {
    unlinkSync(tmp);
  }

  // Негативный тест: loop с exit_on не-review/final ролью должен падать.
  const badLoopYaml = `
name: badloop
steps: []
loop:
  steps:
    - id: impl
      agent: glm
      role: implement
      budget: { wall_time_sec: 100, max_steps: 2 }
      depends_on: []
    - id: exit
      agent: codex
      role: implement
      budget: { wall_time_sec: 100, max_steps: 2 }
      depends_on: [impl]
  exit_on: exit
  max_iterations: 3
`;
  const tmpLoop = join(process.cwd(), "workflows", "_bad_loop.yaml");
  writeFileSync(tmpLoop, badLoopYaml);
  try {
    await loadWorkflow(tmpLoop);
    console.error("✗ bad_loop     exit_on non-review role NOT rejected");
    failures++;
  } catch (e) {
    console.log(`✓ bad_loop     exit_on non-review role correctly rejected`);
  } finally {
    unlinkSync(tmpLoop);
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
