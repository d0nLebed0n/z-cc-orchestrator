/**
 * Unit-smoke: семьи, envelope, выбор ревьюера, budget.
 * Запуск: npx tsx scripts/smoke-units.ts
 *
 * review #10: ранее падал на удалённом export `AGENTS` и на неинициализированном
 * model registry. Теперь семьи берутся из registry (getAgentFamily), а реестр
 * инициализируется во временную директорию (DEFAULT_CONFIG сеется автоматически).
 */
import { pickReviewer, validReviewerFamilies, getAgentFamily } from "../src/families.ts";
import { makeEnvelope, validateEnvelope } from "../src/envelope.ts";
import { consumeBudget, newBudgetState, CircuitBreaker } from "../src/resilience.ts";
import { createTask, upsertStep, getTask, initBlackboard } from "../src/blackboard.ts";
import { loadModelsConfig } from "../src/model-registry.ts";
import { BLACKBOARD_DIR } from "../src/blackboard.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("✗ " + msg);
    process.exit(1);
  }
  console.log("✓ " + msg);
}

async function main(): Promise<void> {
  // Инициализировать model registry во временную директорию (review #10):
  // DEFAULT_CONFIG сеется автоматически при отсутствии models.yaml, после чего
  // getAgentFamily/pickReviewer видят claude/codex/glm/ollama.
  const regRoot = mkdtempSync(join(tmpdir(), "orch-smoke-reg-"));
  loadModelsConfig(join(regRoot, BLACKBOARD_DIR));

  // Семьи — из registry (AGENTS удалён, теперь families.ts делегирует реестру).
  assert(getAgentFamily("claude") === "anthropic", "claude → anthropic");
  assert(getAgentFamily("codex") === "openai", "codex → openai");
  assert(getAgentFamily("glm") === "zai", "glm → zai (not anthropic despite claude binary)");

  // Valid reviewer families
  const revForOpenAI = validReviewerFamilies("openai");
  assert(revForOpenAI.includes("anthropic") && revForOpenAI.includes("zai"), "openAI code → anthropic|zai review");
  assert(!revForOpenAI.includes("openai"), "openAI code cannot self-review");

  // pickReviewer: codex author → claude or glm (not codex)
  const r = pickReviewer("openai");
  assert(r === "claude" || r === "glm", `codex author → reviewer is claude|glm (got ${r})`);

  // pickReviewer with same-family prefer → throws
  try {
    pickReviewer("openai", "codex");
    console.error("✗ pickReviewer(openai, codex) should throw");
    process.exit(1);
  } catch {
    console.log("✓ pickReviewer(openai, codex) throws CrossFamilyViolation");
  }

  // Envelope: family inferred from agent
  const env = makeEnvelope({
    id: "T-001",
    agent: "glm",
    role: "implement",
    prompt: "do something",
    target_paths: ["src/x.ts"],
    context: null,
    budget: { wall_time_sec: 600, max_steps: 2 },
    effort: "low",
  });
  assert(env.family === "zai", "envelope.glm → family zai");
  validateEnvelope(env);
  console.log("✓ validateEnvelope(glm) ok");

  // local / ollama
  assert(getAgentFamily("ollama") === "local", "ollama → local");
  assert(!validReviewerFamilies("anthropic").includes("local"), "local is NOT a reviewer for anthropic");
  assert(!validReviewerFamilies("openai").includes("local"), "local is NOT a reviewer for openai");
  assert(validReviewerFamilies("local").includes("anthropic"), "local code → anthropic can review");
  assert(!validReviewerFamilies("local").includes("local"), "local cannot self-review");

  const ollamaEnv = makeEnvelope({
    id: "T-OLLAMA", agent: "ollama", role: "implement", prompt: "x",
    target_paths: ["src/a.ts"], context: null,
    budget: { wall_time_sec: 600, max_steps: 2 }, effort: "low",
  });
  assert(ollamaEnv.family === "local", "envelope.ollama → family local");
  validateEnvelope(ollamaEnv);

  // Envelope family mismatch → throws
  try {
    makeEnvelope({
      id: "T-002",
      agent: "claude",
      family: "openai", // wrong
      role: "implement",
      prompt: "x",
      target_paths: [],
      context: null,
      budget: { wall_time_sec: 100, max_steps: 1 },
    });
    console.error("✗ envelope family mismatch should throw");
    process.exit(1);
  } catch {
    console.log("✓ envelope family mismatch rejected");
  }

  // Budget: consume + exhaust
  let bs = newBudgetState("S1");
  const envBudget = { wall_time_sec: 100, max_steps: 2 } as const;
  const fakeResult = { duration_ms: 60_000, success: true } as never;
  bs = consumeBudget(bs, { budget: envBudget } as never, fakeResult);
  assert(bs.attempts === 1, "budget: 1 attempt consumed");
  bs = consumeBudget(bs, { budget: envBudget } as never, fakeResult);
  assert(bs.exhausted, "budget: exhausted after max_steps=2");

  // Circuit breaker
  const cb = new CircuitBreaker(3);
  assert(!cb.isTripped("codex"), "breaker: not tripped initially");
  cb.recordFailure("codex");
  cb.recordFailure("codex");
  cb.recordFailure("codex");
  assert(cb.isTripped("codex"), "breaker: tripped after 3 failures");
  cb.recordSuccess("codex");
  assert(!cb.isTripped("codex"), "breaker: reset after success");

  // ── state.json race (review risk #1): 50 параллельных upsertStep ──
  // До мьютекса last-write-wins терял бы записи. Теперь все 50 должны сохраниться.
  const raceRoot = mkdtempSync(join(tmpdir(), "orch-race-"));
  await initBlackboard(raceRoot);
  const task = await createTask({
    prompt: "race test", workflow: "x", project: raceRoot, root: raceRoot,
  });
  const N = 50;
  const steps = Array.from({ length: N }, (_, i) => ({
    id: `${task.id}-S${String(i + 1).padStart(2, "0")}`,
    task_id: task.id,
    agent: "ollama", family: "local", role: "implement",
    status: "success" as const,
    started_at: null, finished_at: null, attempts: 1,
    result_path: null, error: null,
  }));
  await Promise.all(steps.map((s) => upsertStep(task.id, s, raceRoot)));
  const after = await getTask(task.id, raceRoot);
  assert(after!.steps.length === N, `race: all ${N} steps persisted (got ${after!.steps.length})`);
  const ids = new Set(after!.steps.map((s) => s.id));
  assert(steps.every((s) => ids.has(s.id)), "race: no step lost (all ids present)");
  rmSync(raceRoot, { recursive: true, force: true });
  rmSync(regRoot, { recursive: true, force: true });

  console.log("\nAll unit checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
