import { WorkflowSchema, buildLoadedWorkflow, pathsOverlap, routeSubtask } from "../src/workflow.ts";
import type { Subtask } from "../src/plan.ts";
import { loadModelsConfig } from "../src/model-registry.ts";
import { BLACKBOARD_DIR } from "../src/blackboard.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// review #10: routeSubtask зовёт getAgentFamily → нужен инициализированный
// model registry (DEFAULT_CONFIG сеется автоматически во временную директорию).
const regRoot = mkdtempSync(join(tmpdir(), "orch-smoke-wf-"));
loadModelsConfig(join(regRoot, BLACKBOARD_DIR));

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}
function mkSubtask(complexity: number): Subtask {
  return { id: `P${complexity}`, title: "t", goal: "g", complexity, target_paths: [], acceptance_criteria: "ok" };
}

// routing
assert(routeSubtask(mkSubtask(85), ["glm", "ollama"], 80) === "glm", "85/80 → glm");
assert(routeSubtask(mkSubtask(70), ["glm", "ollama"], 80) === "ollama", "70/80 → ollama");
assert(routeSubtask(mkSubtask(99), ["glm", "ollama"], 100) === "ollama", "99/100 → ollama");
assert(routeSubtask(mkSubtask(100), ["glm", "ollama"], 100) === "glm", "100/100 → glm");
assert(routeSubtask(mkSubtask(5), ["glm", "ollama"], 0) === "glm", "5/0 → glm");

// path overlap: parent/child + normalization
assert(pathsOverlap(["src"], ["src/foo.ts"]), "src overlaps src/foo.ts");
assert(pathsOverlap(["src/foo.ts"], ["src/./foo.ts"]), "normalized same path overlaps");
assert(!pathsOverlap(["src/a.ts"], ["src/b.ts"]), "distinct files don't overlap");
assert(!pathsOverlap(["src"], ["test"]), "distinct dirs don't overlap");
assert(pathsOverlap(["a/b/../c.ts"], ["a/c.ts"]), "normalize collapses .. (a/b/../c.ts == a/c.ts)");
assert(pathsOverlap(["src/./sub/../x.ts"], ["src/x.ts"]), "normalize collapses ./ and ../ mixed");

// fan_out compiles
const wf = WorkflowSchema.parse({
  name: "decomposed",
  complexity_threshold: 80,
  max_parallel: 3,
  steps: [
    { id: "plan", agent: "claude", role: "plan", budget: { wall_time_sec: 600, max_steps: 2 }, depends_on: [] },
    { id: "build", fan_out: true, from_plan: "plan", agents: ["glm", "ollama"], review: true, role: "implement", budget: { wall_time_sec: 600, max_steps: 2 }, depends_on: ["plan"] },
    { id: "final", agent: "claude", role: "final", budget: { wall_time_sec: 600, max_steps: 2 }, depends_on: ["build"] },
  ],
});
const loaded = buildLoadedWorkflow(wf);
assert(loaded.fanOuts.length === 1, "1 fanOut registered");
assert(loaded.fanOuts[0]!.fromPlanId === "plan", "fromPlanId=plan");
// fan_out step NOT in preLevels
const preIds = loaded.preLevels.flat().map((s) => s.id);
assert(!preIds.includes("build"), "fan_out excluded from preLevels");
// plan runs BEFORE fan-out (in preLevels); final depends on build → runs AFTER fan-out.
assert(preIds.includes("plan"), "plan in preLevels (before fan-out)");
assert(!preIds.includes("final"), "final NOT in preLevels (depends on fan_out)");
const postFanOutIds = loaded.postFanOutLevels.flat().map((s) => s.id);
assert(postFanOutIds.includes("final"), "final in postFanOutLevels (after fan-out)");

// errors
function expectThrow(label: string, fn: () => unknown): void {
  try { fn(); console.error("✗ " + label + " should throw"); process.exit(1); }
  catch { console.log("✓ " + label); }
}
expectThrow("fan_out without from_plan", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "b", fan_out: true, agents: ["ollama"], role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }] }));
expectThrow("fan_out without agents", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "b", fan_out: true, from_plan: "p", role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }] }));
expectThrow("fan_out with openai (codex) agent", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "p", agent: "claude", role: "plan", budget: { wall_time_sec: 1, max_steps: 1 } }, { id: "b", fan_out: true, from_plan: "p", agents: ["codex"], review: true, role: "implement", budget: { wall_time_sec: 1, max_steps: 1 }, depends_on: ["p"] }] }));
expectThrow("from_plan forward reference", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "b", fan_out: true, from_plan: "later", agents: ["ollama"], role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }, { id: "later", agent: "claude", role: "plan", budget: { wall_time_sec: 1, max_steps: 1 } }] }));
expectThrow("non-fan_out step without agent", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "s", role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }] }));
expectThrow("fan_out inside loop.steps", () => WorkflowSchema.parse({ name: "x", loop: { steps: [{ id: "f", fan_out: true, from_plan: "f", agents: ["ollama"], role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }], exit_on: "f", max_iterations: 1 } }));
expectThrow("fan_out inside post_steps", () => WorkflowSchema.parse({ name: "x", loop: { steps: [{ id: "s", agent: "glm", role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }, { id: "r", agent: "codex", role: "review", budget: { wall_time_sec: 1, max_steps: 1 }, depends_on: ["s"] }], exit_on: "r", max_iterations: 1 }, post_steps: [{ id: "f", fan_out: true, from_plan: "s", agents: ["ollama"], role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }] }));

console.log("\nAll workflow checks passed.");
rmSync(regRoot, { recursive: true, force: true });
