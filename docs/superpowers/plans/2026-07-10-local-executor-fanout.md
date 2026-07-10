# Local Executor (Ollama) + Fan-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Qwen3-Coder-30B (local Ollama) as a fourth family `local` + agent `ollama`, and add a declarative `fan_out` workflow step that Claude-decomposed subtasks fan out across glm (complex) and ollama (trivial), each independently reviewed by codex.

**Architecture:** Claude plans + scores subtask complexity 0..100; the runner expands a `fan_out` step into N (implement+review) pairs, routing by `complexity_threshold` (default 80). Two-phase merge: Phase A runs implementers in parallel (each in its own worktree, no merge yet); Phase B sequentially creates a disposable candidate branch per subtask, merges the implement branch, runs codex review there, and promotes the candidate into integration only on APPROVE.

**Tech Stack:** Node.js ≥ 20, TypeScript, zod, yaml, `fetch` (no new deps), Ollama OpenAI-compatible `/v1/chat/completions`.

## Global Constraints

- TypeScript `strict`; `tsc --noEmit` must pass at root after every task.
- No new runtime dependencies (use built-in `fetch`, `node:fs`, `node:path`, existing `zod`/`yaml`).
- `local` is an **implement-only** family: never a reviewer candidate.
- stepId fan-out segment uses **`~`** (never `#` — `#` is the loop-iteration separator). Full scheme: `<base>[#<iteration>][~<subtask>[r]]`.
- `max_parallel` priority: **CLI `RunOptions.maxParallel` > YAML `max_parallel` > 3**.
- All file paths relative to repo root `/Users/ilyalebedev/Desktop/iva-gang/z-cc-orchestrator`.
- Existing smoke scripts (`scripts/smoke*.ts`) must still pass; extend, don't break.

---

### Task 1: Add `local` family + `ollama` agent (families + envelope)

**Files:**
- Modify: `src/families.ts`
- Modify: `src/envelope.ts`
- Modify: `scripts/smoke-units.ts` (extend assertions)

**Interfaces:**
- Produces: `Family = "anthropic" | "openai" | "zai" | "local"`, `AgentName = "claude" | "codex" | "glm" | "ollama"`, `AGENTS["ollama"]`, `validReviewerFamilies` excludes `local`, `makeEnvelope({agent:"ollama"})` infers `family:"local"`.

- [ ] **Step 1: Extend `families.ts` types + AGENTS**

Replace the type/agent block in `src/families.ts`:

```ts
export type Family = "anthropic" | "openai" | "zai" | "local";
export type AgentName = "claude" | "codex" | "glm" | "ollama";

export interface AgentInfo {
  name: AgentName;
  family: Family;
  /** Каким бинарником запускается (справочно). local-агенты не имеют CLI — binary "none". */
  binary: "claude" | "codex" | "ollama" | "none";
}

export const AGENTS: Record<AgentName, AgentInfo> = {
  claude: { name: "claude", family: "anthropic", binary: "claude" },
  codex: { name: "codex", family: "openai", binary: "codex" },
  glm: { name: "glm", family: "zai", binary: "claude" },
  ollama: { name: "ollama", family: "local", binary: "ollama" },
};
```

- [ ] **Step 2: Exclude `local` from reviewer candidates**

Replace `validReviewerFamilies`:

```ts
/** Все семьи, отличные от данной и способные ревьюить. local — implement-only, не ревьюер. */
const REVIEWER_FAMILIES: Family[] = ["anthropic", "openai", "zai"];

export function validReviewerFamilies(author: Family): Family[] {
  return REVIEWER_FAMILIES.filter((f) => f !== author);
}
```

Also fix `pickReviewer` default selection so it never returns `ollama` (it already iterates `validReviewerFamilies`, which now excludes `local`, so the candidate pick is safe — but the ternary chain only knows claude/codex/glm; add a guard). Replace the default-pick block:

```ts
  const valid = validReviewerFamilies(authorFamily);
  // ollama никогда не ревьюер (local — implement-only); выбираем из сильных семей.
  const candidate: AgentName =
    valid.includes("anthropic") ? "claude"
    : valid.includes("openai") ? "codex"
    : valid.includes("zai") ? "glm"
    : "claude";
  return candidate;
```

- [ ] **Step 3: Extend `envelope.ts` enums**

In `src/envelope.ts`, change the two enums (point #3 — both, not just one):

```ts
  agent: z.enum(["claude", "codex", "glm", "ollama"]),
  family: z.enum(["anthropic", "openai", "zai", "local"]),
```

(`makeEnvelope` infers family from `AGENTS[agent].family`, so `ollama` → `local` automatically. `validateEnvelope` compares against `AGENTS[e.agent].family` — already correct once AGENTS has ollama.)

- [ ] **Step 4: Extend `prompts/roles.ts` agentIdentity to cover ollama**

In `agentIdentity` add the case (the switch is exhaustive over AgentName):

```ts
function agentIdentity(agent: AgentName, family: Family): string {
  switch (agent) {
    case "claude":
      return "Claude (Anthropic)";
    case "codex":
      return "Codex (OpenAI)";
    case "glm":
      return "GLM (Z.ai)";
    case "ollama":
      return "Qwen3-Coder (local, via Ollama)";
  }
}
```

- [ ] **Step 5: Write failing unit tests**

Add to `scripts/smoke-units.ts` `main()` (after existing family asserts):

```ts
  // local / ollama
  assert(AGENTS.ollama.family === "local", "ollama → local");
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
```

- [ ] **Step 6: Run tests, fix until green**

Run: `npx tsx scripts/smoke-units.ts`
Expected: all ✓ including the new `ollama → local` assertions.

Run: `npx tsc --noEmit`
Expected: exit 0 (the exhaustive switch in `agentIdentity` + `pickReviewer` must compile).

- [ ] **Step 7: Commit**

```bash
git add src/families.ts src/envelope.ts src/prompts/roles.ts scripts/smoke-units.ts
git commit -m "feat(families): add local family + ollama agent (implement-only)"
```

---

### Task 2: stepId `~` segment for fan-out subtasks (blackboard)

**Files:**
- Modify: `src/blackboard.ts`
- Create: `scripts/smoke-stepid.ts`

**Interfaces:**
- Produces: `newSubtaskStepId(base, subtaskId, isReview)` → `<base>~P1` / `<base>~P1r`; `newReviewSubtaskStepId` alias. `parseStepSegments(stepId)` → `{ base, iteration?, subtask?, isReview? }`.

- [ ] **Step 1: Write failing test for `~` segment parsing**

Create `scripts/smoke-stepid.ts`:

```ts
import { newStepId, parseStepSegments, newSubtaskStepId } from "../src/blackboard.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// base stepId (no loop, no fanout)
let s = newStepId("T-X", 2, 1);
assert(s === "T-X-S02", `base stepId = ${s}`);
assert(JSON.stringify(parseStepSegments(s)) === JSON.stringify({ base: "T-X-S02", iteration: null, subtask: null, isReview: false }), "parse base");

// loop iteration: #2
s = newStepId("T-X", 3, 2);
assert(s === "T-X-S03#2", `loop stepId = ${s}`);
const seg = parseStepSegments(s);
assert(seg.iteration === 2 && seg.subtask === null, "parse loop: iteration=2, no subtask");

// fan-out subtask implement: ~P1
s = newSubtaskStepId("T-X-S02", "P1", false);
assert(s === "T-X-S02~P1", `subtask implement = ${s}`);
const seg2 = parseStepSegments(s);
assert(seg2.subtask === "P1" && seg2.isReview === false && seg2.iteration === null, "parse subtask P1");

// fan-out subtask review: ~P1r
s = newSubtaskStepId("T-X-S02", "P1", true);
assert(s === "T-X-S02~P1r", `subtask review = ${s}`);
const seg3 = parseStepSegments(s);
assert(seg3.subtask === "P1" && seg3.isReview === true, "parse subtask P1 review");

// orthogonal: iteration + subtask don't collide
assert(newStepId("T-X",3,2) !== newSubtaskStepId("T-X-S03","2",false), "#2 != ~2");

console.log("\nAll stepId checks passed.");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-stepid.ts`
Expected: FAIL — `parseStepSegments` / `newSubtaskStepId` not exported.

- [ ] **Step 3: Implement segment helpers in `blackboard.ts`**

Add after the existing `newStepId`:

```ts
/** Fan-out подзадача: суффикс ~<subtaskId>, review добавляет r. Сегмент `~`, не `#` (# = итерация цикла). */
export function newSubtaskStepId(baseStepId: string, subtaskId: string, isReview = false): string {
  return `${baseStepId}~${subtaskId}${isReview ? "r" : ""}`;
}

/** Разобрать stepId на сегменты: <base>[#<iteration>][~<subtask>[r]]. */
export interface StepSegments {
  base: string;
  iteration: number | null;
  subtask: string | null;
  isReview: boolean;
}
export function parseStepSegments(stepId: string): StepSegments {
  const tildeIdx = stepId.indexOf("~");
  const hashIdx = stepId.indexOf("#");
  const base = stepId.slice(0, Math.min(
    tildeIdx === -1 ? stepId.length : tildeIdx,
    hashIdx === -1 ? stepId.length : hashIdx,
  ));
  let iteration: number | null = null;
  let subtask: string | null = null;
  let isReview = false;
  if (hashIdx !== -1) {
    const after = stepId.slice(hashIdx + 1, tildeIdx === -1 ? stepId.length : tildeIdx);
    iteration = Number.parseInt(after, 10);
    if (Number.isNaN(iteration)) iteration = null;
  }
  if (tildeIdx !== -1) {
    let after = stepId.slice(tildeIdx + 1);
    if (after.endsWith("r")) { isReview = true; after = after.slice(0, -1); }
    subtask = after || null;
  }
  return { base, iteration, subtask, isReview };
}
```

- [ ] **Step 4: Run tests, fix until green**

Run: `npx tsx scripts/smoke-stepid.ts` → all ✓.
Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/blackboard.ts scripts/smoke-stepid.ts
git commit -m "feat(blackboard): ~ subtask segment for fan-out stepIds"
```

---

### Task 3: Decomposition plan schema + parser (`src/plan.ts`)

**Files:**
- Create: `src/plan.ts`
- Create: `scripts/smoke-plan.ts`

**Interfaces:**
- Produces: `SubtaskSchema`, `Subtask` (`{id,title,goal,complexity,target_paths,acceptance_criteria}`), `SubtaskPlanSchema`, `SubtaskPlan`, `parsePlan(output: string): SubtaskPlan`.

- [ ] **Step 1: Write failing test**

Create `scripts/smoke-plan.ts`:

```ts
import { parsePlan } from "../src/plan.ts";
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// valid JSON inside markdown fences
const valid = "Here is the plan:\n```json\n{\"subtasks\":[{\"id\":\"P1\",\"title\":\"add fn\",\"goal\":\"write add\",\"complexity\":20,\"target_paths\":[\"src/math.ts\"],\"acceptance_criteria\":\"add(2,3)==5\"}]}\n```\ndone";
const p = parsePlan(valid);
assert(p.subtasks.length === 1, "parsed 1 subtask");
assert(p.subtasks[0]!.complexity === 20, "complexity 20");
assert(p.subtasks[0]!.target_paths[0] === "src/math.ts", "target_path");

// bare JSON (no fences)
const bare = '{"subtasks":[{"id":"P1","title":"t","goal":"g","complexity":90,"target_paths":["a.ts"],"acceptance_criteria":"ok"}]}';
const p2 = parsePlan(bare);
assert(p2.subtasks[0]!.complexity === 90, "bare json parsed");

// invalid: throws
for (const bad of ["no json here", "", "{}", "{\"subtasks\":[]}", "{\"subtasks\":[{\"id\":\"P1\"}]}"]) {
  try { parsePlan(bad); console.error("✗ should throw on: " + bad); process.exit(1); }
  catch { console.log("✓ rejected: " + JSON.stringify(bad)); }
}

// complexity bounds
try { parsePlan('{"subtasks":[{"id":"P1","title":"t","goal":"g","complexity":150,"target_paths":["a.ts"],"acceptance_criteria":"ok"}]}'); console.error("✗ complexity 150 should throw"); process.exit(1); }
catch { console.log("✓ complexity >100 rejected"); }

console.log("\nAll plan checks passed.");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-plan.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/plan.ts`**

```ts
/**
 * План декомпозиции из шага plan (claude): JSON, валидируется zod.
 * agent НЕ задаётся в плане — он выводится раннером по complexity vs threshold.
 */
import { z } from "zod";

export const SubtaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  complexity: z.number().int().min(0).max(100),
  target_paths: z.array(z.string().min(1)).default([]),
  acceptance_criteria: z.string().min(1),
});
export type Subtask = z.infer<typeof SubtaskSchema>;

export const SubtaskPlanSchema = z.object({
  subtasks: z.array(SubtaskSchema).min(1),
});
export type SubtaskPlan = z.infer<typeof SubtaskPlanSchema>;

/**
 * Достать JSON-план из вывода plan-шага. Поддерживает:
 *  - fenced ```json ... ```
 *  - голый {...} объект
 * Бросает при отсутствии/невалидности JSON или провале zod-схемы.
 */
export function parsePlan(output: string): SubtaskPlan {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("parsePlan: empty output");

  // 1. fenced ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]!.trim());

  // 2. первый {...} блок в исходном тексте
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }

  let parsed: unknown = null;
  let lastErr: unknown = null;
  for (const c of candidates) {
    try { parsed = JSON.parse(c); break; }
    catch (e) { lastErr = e; }
  }
  if (parsed === null) {
    throw new Error(`parsePlan: no valid JSON found in plan output${lastErr ? ` (${lastErr instanceof Error ? lastErr.message : lastErr})` : ""}`);
  }
  return SubtaskPlanSchema.parse(parsed);
}
```

- [ ] **Step 4: Run tests until green**

Run: `npx tsx scripts/smoke-plan.ts` → all ✓.
Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/plan.ts scripts/smoke-plan.ts
git commit -m "feat(plan): SubtaskPlan schema + parsePlan"
```

---

### Task 4: Workflow schema — `fan_out` step + `complexity_threshold` + path-overlap normalization

**Files:**
- Modify: `src/workflow.ts`
- Create: `scripts/smoke-workflow.ts`

**Interfaces:**
- Produces: `WorkflowStepSchema` gains optional `fan_out`/`from_plan`/`agents`/`review`; `WorkflowSchema` gains optional `complexity_threshold`/`max_parallel`; `FanOutSpec`; `LoadedWorkflow.fanOuts`; `routeSubtask(subtask, agents, threshold): AgentName`; `pathsOverlap(a[], b[])` (normalized + parent/child). Compilation excludes `fan_out` steps from `preLevels`, validates `from_plan` references an earlier step + no openai in agents.

- [ ] **Step 1: Write failing test**

Create `scripts/smoke-workflow.ts`:

```ts
import { WorkflowSchema, buildLoadedWorkflow, pathsOverlap, routeSubtask } from "../src/workflow.ts";
import type { Subtask } from "../src/plan.ts";
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
// plan + final still in preLevels
assert(preIds.includes("plan") && preIds.includes("final"), "plan+final in preLevels");

// errors
function expectThrow(label: string, fn: () => unknown): void {
  try { fn(); console.error("✗ " + label + " should throw"); process.exit(1); }
  catch { console.log("✓ " + label); }
}
expectThrow("fan_out without from_plan", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "b", fan_out: true, agents: ["ollama"], role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }] }));
expectThrow("fan_out without agents", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "b", fan_out: true, from_plan: "p", role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }] }));
expectThrow("fan_out with openai (codex) agent", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "p", agent: "claude", role: "plan", budget: { wall_time_sec: 1, max_steps: 1 } }, { id: "b", fan_out: true, from_plan: "p", agents: ["codex"], review: true, role: "implement", budget: { wall_time_sec: 1, max_steps: 1 }, depends_on: ["p"] }] }));
expectThrow("from_plan forward reference", () => WorkflowSchema.parse({ name: "x", steps: [{ id: "b", fan_out: true, from_plan: "later", agents: ["ollama"], role: "implement", budget: { wall_time_sec: 1, max_steps: 1 } }, { id: "later", agent: "claude", role: "plan", budget: { wall_time_sec: 1, max_steps: 1 } }] }));

console.log("\nAll workflow checks passed.");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-workflow.ts` → FAIL (exports missing).

- [ ] **Step 3: Extend `WorkflowStepSchema` + `WorkflowSchema`**

In `src/workflow.ts`, add to `WorkflowStepSchema` (after `allow_same_family`):

```ts
  /** Если true — шаг раскрывается раннером в N (implement+review) по плану from_plan. */
  fan_out: z.boolean().default(false),
  /** id plan-шага, чей вывод парсится как SubtaskPlan. Обязательно при fan_out. */
  from_plan: z.string().min(1).optional(),
  /** Допустимые исполнители подзадач. Обязательно при fan_out. */
  agents: z.array(z.enum(["claude", "codex", "glm", "ollama"])).optional(),
  /** Добавить codex(review) на каждую подзадачу. */
  review: z.boolean().default(false),
```

Extend `WorkflowSchema` with two root params + a refine for fan_out consistency:

```ts
export const WorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  complexity_threshold: z.number().int().min(0).max(100).default(80),
  max_parallel: z.number().int().positive().default(3),
  steps: z.array(WorkflowStepSchema).default([]),
  loop: LoopSchema.optional(),
  post_steps: z.array(WorkflowStepSchema).default([]),
}).refine(
  (w) => w.steps.length > 0 || w.loop !== undefined || w.post_steps.length > 0,
  { message: "Workflow must have steps, loop, or post_steps" },
).refine(
  (w) => w.post_steps.length === 0 || w.loop !== undefined,
  { message: "post_steps require a loop (otherwise use steps)" },
)
// fan_out consistency
.refine(
  (w) => w.steps.every((s) => !s.fan_out || (s.from_plan && s.agents && s.agents.length > 0)),
  { message: "fan_out steps require from_plan and agents" },
)
.refine(
  (w) => w.steps.every((s) => !s.fan_out || !s.review || !s.agents!.includes("codex")),
  { message: "fan_out with review cannot list codex in agents (codex is the reviewer)" },
)
// from_plan references an earlier step (declared before it)
.refine((w) => {
  const ids = w.steps.map((s) => s.id);
  for (const s of w.steps) {
    if (s.fan_out && s.from_plan) {
      const fi = ids.indexOf(s.from_plan);
      const si = ids.indexOf(s.id);
      if (fi === -1 || fi >= si) return false;
    }
  }
  return true;
}, { message: "fan_out.from_plan must reference an earlier step id" });
```

- [ ] **Step 4: Add `pathsOverlap` + `routeSubtask` + `FanOutSpec` + compilation**

Add to `src/workflow.ts` (the AGENTS import already exists; `Family`/`AgentName` available):

```ts
import { AGENTS, type AgentName } from "./families.ts";
import type { Subtask } from "./plan.ts";

/** Нормализовать путь: убрать ./ и повторные слэши, без leading ./ */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/\.\//g, "/");
}

/** Пересекаются ли две области target_paths? parent/child считается пересечением. */
export function pathsOverlap(a: string[], b: string[]): boolean {
  const na = a.map(norm);
  const nb = b.map(norm);
  for (const x of na) for (const y of nb) {
    if (x === y) return true;
    if (x.startsWith(y + "/") || y.startsWith(x + "/")) return true; // parent/child
  }
  return false;
}

/** Маршрутизация подзадачи: complexity >= threshold → strong, иначе local. Берёт первого подходящего из agents. */
export function routeSubtask(subtask: Subtask, agents: AgentName[], threshold: number): AgentName {
  const strong = subtask.complexity >= threshold;
  for (const a of agents) {
    const fam = AGENTS[a].family;
    if (strong && fam !== "local") return a;
    if (!strong && fam === "local") return a;
  }
  throw new Error(`routeSubtask: no agent for subtask ${subtask.id} (complexity ${subtask.complexity}, threshold ${threshold}, side=${strong ? "strong" : "local"}) in agents [${agents.join(",")}]`);
}

export interface FanOutSpec {
  step: ResolvedStep;
  fromPlanId: string;
  agents: AgentName[];
  review: boolean;
}
```

Now change `LoadedWorkflow` to add `fanOuts` and `buildLoadedWorkflow` to populate it (split preSteps into non-fanout levels; collect fanOut specs):

```ts
export interface LoadedWorkflow {
  wf: Workflow;
  preLevels: ResolvedStep[][];
  loopBody: ResolvedStep[];
  loop: Loop | undefined;
  postLevels: ResolvedStep[][];
  allSteps: ResolvedStep[];
  fanOuts: FanOutSpec[];
}
```

Replace the `preSteps`/`preLevels` portion of `buildLoadedWorkflow`:

```ts
export function buildLoadedWorkflow(wf: Workflow): LoadedWorkflow {
  const allPre = resolveWorkflow(wf.steps);
  assertCrossFamilyReview(allPre);

  // Разделить: обычные шаги идут в preLevels, fan_out-шаги — в fanOuts.
  const plainSteps = allPre.filter((s) => !s.fan_out);
  const fanOutSteps = allPre.filter((s) => s.fan_out);
  const preLevels = topoLevels(plainSteps);
  for (const level of preLevels) assertNonOverlappingPaths(level);

  const fanOuts: FanOutSpec[] = fanOutSteps.map((s) => ({
    step: s,
    fromPlanId: s.from_plan!,
    agents: s.agents!,
    review: s.review,
  }));
  if (fanOuts.length > 1) {
    throw new Error("Only one fan_out step per workflow is supported (YAGNI)");
  }

  let loopBody: ResolvedStep[] = [];
  let loop: Loop | undefined;
  if (wf.loop) {
    loop = wf.loop;
    const loopSteps = resolveWorkflow(loop.steps);
    const exitStep = loopSteps.find((s) => s.id === loop!.exit_on);
    if (!exitStep) throw new Error(`loop.exit_on='${loop.exit_on}' not found in loop.steps`);
    if (exitStep.role !== "review" && exitStep.role !== "final") {
      throw new Error(`loop.exit_on='${loop.exit_on}' must be role review or final (got ${exitStep.role})`);
    }
    assertCrossFamilyReview(loopSteps);
    loopBody = orderLoopBody(loopSteps);
  }

  const postSteps = resolveWorkflow(wf.post_steps);
  assertCrossFamilyReview(postSteps);
  const postLevels = topoLevels(postSteps);
  for (const level of postLevels) assertNonOverlappingPaths(level);

  const allSteps = [...allPre, ...loopBody, ...postSteps];
  return { wf, preLevels, loopBody, loop, postLevels, allSteps, fanOuts };
}
```

- [ ] **Step 5: Run tests until green**

Run: `npx tsx scripts/smoke-workflow.ts` → all ✓.
Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/workflow.ts scripts/smoke-workflow.ts
git commit -m "feat(workflow): fan_out step + complexity_threshold + path overlap"
```

---

### Task 5: Ollama tool executors + path sanitize (`workers/ollama-tools.ts`)

**Files:**
- Create: `src/workers/ollama-tools.ts`
- Create: `scripts/smoke-ollama-tools.ts`

**Interfaces:**
- Produces: `ToolCall` (`{name, args}`), `parseToolCalls(content)` (extracts `<tools>{...}</tools>`), `executeTool(call, cwd)` → string result. Path sanitize rejects `..` escaping `cwd`.

- [ ] **Step 1: Write failing test**

Create `scripts/smoke-ollama-tools.ts`:

```ts
import { parseToolCalls, executeTool, sanitizePath } from "../src/workers/ollama-tools.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// parse single tool call
let calls = parseToolCalls('<tools>\n{"name":"read_file","arguments":{"path":"a.ts"}}\n</tools>');
assert(calls.length === 1 && calls[0]!.name === "read_file" && calls[0]!.args.path === "a.ts", "parse read_file");

// parse multiple (rare but possible)
calls = parseToolCalls('<tools>{"name":"list_dir","arguments":{"path":"src"}}</tools> text <tools>{"name":"read_file","arguments":{"path":"x"}}</tools>');
assert(calls.length === 2, "parse 2 calls");

// no tools
assert(parseToolCalls("just text").length === 0, "no tools → empty");
assert(parseToolCalls("").length === 0, "empty → empty");

// malformed json → ignored, not crash
calls = parseToolCalls("<tools>not json</tools>");
assert(calls.length === 0, "malformed ignored");

// path sanitize
assert(sanitizePath(join("/root"), "src/a.ts") === join("/root", "src/a.ts"), "relative joined");
assert(sanitizePath(join("/root"), "/root/src/a.ts") === join("/root", "src/a.ts"), "absolute under root ok");
let threw = false;
try { sanitizePath(join("/root"), "../etc/passwd"); } catch { threw = true; }
assert(threw, "../ escape rejected");
threw = false;
try { sanitizePath(join("/root"), "/etc/passwd"); } catch { threw = true; }
assert(threw, "absolute outside root rejected");

// execute: read + write + list
const root = mkdtempSync(join(tmpdir(), "ollama-tools-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.ts"), "export const x = 1;");
const r1 = executeTool({ name: "read_file", args: { path: "src/a.ts" } }, root);
assert(r1.includes("export const x = 1;"), "read_file returns content");
executeTool({ name: "write_file", args: { path: "src/b.ts", content: "export const y = 2;" } }, root);
const r3 = executeTool({ name: "list_dir", args: { path: "src" } }, root);
assert(r3.includes("a.ts") && r3.includes("b.ts"), "list_dir shows both");
const unknown = executeTool({ name: "nope", args: {} }, root);
assert(unknown.includes("unknown tool"), "unknown tool reported");
rmSync(root, { recursive: true, force: true });

console.log("\nAll ollama-tools checks passed.");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-ollama-tools.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/workers/ollama-tools.ts`**

```ts
/**
 * Инструменты для tool-loop воркера ollama. Модель (Unsloth-квант) не отдаёт
 * нативный tool_calls — она встраивает <tools>{...}</tools> в content.
 * Парсим этот текстовый протокол, исполняем относительно worktree (cwd).
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";

export interface ToolCall {
  name: "read_file" | "write_file" | "list_dir" | string;
  args: Record<string, string>;
}

/** Достать все <tools>{json}</tools> из content модели. Malformed — пропускаем. */
export function parseToolCalls(content: string): ToolCall[] {
  const out: ToolCall[] = [];
  const re = /<tools>\s*(\{[\s\S]*?\})\s*<\/tools>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1]!);
      if (obj && typeof obj === "object" && typeof obj.name === "string") {
        out.push({ name: obj.name, args: obj.arguments ?? obj.args ?? {} });
      }
    } catch {
      // malformed json in this block — skip
    }
  }
  return out;
}

/** Защищённое разрешение пути: относительный к cwd; reject выхода за cwd. */
export function sanitizePath(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? normalize(p) : normalize(join(cwd, p));
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path '${p}' escapes worktree root ${cwd}`);
  }
  return abs;
}

/** Исполнить один tool-вызов. Возвращает текст-результат для истории диалога. */
export async function executeTool(call: ToolCall, cwd: string): Promise<string> {
  switch (call.name) {
    case "read_file": {
      const path = sanitizePath(cwd, String(call.args.path ?? ""));
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        return `(error reading ${call.args.path}: ${e instanceof Error ? e.message : e})`;
      }
    }
    case "write_file": {
      const path = sanitizePath(cwd, String(call.args.path ?? ""));
      await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
      await writeFile(path, String(call.args.content ?? ""), "utf8");
      return `(wrote ${call.args.path}, ${String(call.args.content ?? "").length} bytes)`;
    }
    case "list_dir": {
      const path = sanitizePath(cwd, String(call.args.path ?? "."));
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`).join("\n");
      } catch (e) {
        return `(error listing ${call.args.path}: ${e instanceof Error ? e.message : e})`;
      }
    }
    default:
      return `(unknown tool: ${call.name})`;
  }
}
```

- [ ] **Step 4: Run tests until green**

Run: `npx tsx scripts/smoke-ollama-tools.ts` → all ✓.
Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/workers/ollama-tools.ts scripts/smoke-ollama-tools.ts
git commit -m "feat(workers): ollama tool executors + path sanitize"
```

---

### Task 6: `runOllama` worker + ollama role prompt + registration

**Files:**
- Modify: `src/prompts/roles.ts`
- Create: `src/workers/runOllama.ts`
- Modify: `src/workers/index.ts`

**Interfaces:**
- Consumes: `WorkerFn`, `WorkerRunOptions`, `WorkerResult` from `./types.ts`; `parseToolCalls`/`executeTool` from `./ollama-tools.ts`; `TaskEnvelope`; env `OLLAMA_BASE_URL`/`OLLAMA_MODEL`.
- Produces: `runOllama: WorkerFn` registered in `WORKERS`.

- [ ] **Step 1: Add ollama implement prompt to `roles.ts`**

Add after `implementPrompt` a dedicated ollama branch. In `ROLE_PROMPTS` map, ollama shares roles but implement needs the tool catalog. Add a helper and route ollama→implement through it:

```ts
function ollamaImplementPrompt(): string {
  return [
    commonHeader("ollama", "local"),
    "",
    "ROLE: IMPLEMENTER (local model, tool-loop)",
    "You implement the task by calling TOOLS. You CANNOT edit files by writing prose —",
    "you MUST use the tools below. The runner executes each tool call and returns the result.",
    "",
    "AVAILABLE TOOLS (emit EXACTLY this format to call one):",
    "  <tools>{\"name\":\"read_file\",\"arguments\":{\"path\":\"<rel-path>\"}}</tools>",
    "  <tools>{\"name\":\"write_file\",\"arguments\":{\"path\":\"<rel-path>\",\"content\":\"<full file content>\"}}</tools>",
    "  <tools>{\"name\":\"list_dir\",\"arguments\":{\"path\":\"<rel-path>\"}}</tools>",
    "",
    "RULES:",
    "- Use read_file/list_dir to inspect before writing. Paths are relative to the worktree root.",
    "- write_file writes the FULL file content (no diffs). Keep edits minimal but complete.",
    "- One tool call per <tools> block. Wait for the result before the next call.",
    "- When done, emit a final summary message with NO <tools> block (plain text).",
    "- Do NOT call a tool you just called with the same args (it will be deduped).",
    "",
    "SUCCESS: files are written and your final message summarizes what changed.",
  ].join("\n");
}
```

Wire it: change `systemPromptFor` to special-case ollama+implement:

```ts
export function systemPromptFor(role: Role, agent: AgentName, family: Family): string {
  if (agent === "ollama" && role === "implement") return ollamaImplementPrompt();
  const fn = ROLE_PROMPTS[role];
  if (!fn) throw new Error(`No system prompt for role: ${role}`);
  return fn(agent, family);
}
```

- [ ] **Step 2: Implement `src/workers/runOllama.ts`**

```ts
/**
 * runOllama — локальный исполнитель через Ollama OpenAI-compat /v1/chat/completions.
 * Tool-loop: модель встраивает <tools>{...}</tools> в content (нативный tool_calls
 * у Unsloth-кванта не работает). Воркер парсит, исполняет, кормит результат обратно.
 *
 * Защита от зацикливания: лимит итераций (max_steps*8), дедуп read_file, общий таймбокс.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskEnvelope } from "../envelope.ts";
import type { WorkerFn, WorkerResult } from "./types.ts";
import { parseToolCalls, executeTool } from "./ollama-tools.ts";
import { truncate } from "./spawn.ts";

const execFileAsync = promisify(execFile);

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://d0nlebed0n.tail74ba62.ts.net:11434";
const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL ?? "danielsheep/Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS";

const EDITING_ROLES = new Set(["implement", "refine", "fix"]);

async function gitHasChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

async function chat(messages: ChatMessage[], timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        temperature: 0,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export const runOllama: WorkerFn = async (envelope, opts) => {
  const start = Date.now();
  const wallMs = envelope.budget.wall_time_sec * 1000;
  const maxIters = envelope.budget.max_steps * 8;
  const needsEdits = EDITING_ROLES.has(envelope.role);

  // System prompt уже встроен в envelope.prompt (buildWorkerPrompt). Разделяем: первый
  // блок до "---" — system, остальное (TASK/CONTEXT) — user. Упрощённо: шлём как user,
  // с явным system, взятым из ролей. Здесь просто используем envelope.prompt как user msg,
  // плюс минимальный system — каталог tools уже внутри envelope.prompt (ollamaImplementPrompt).
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a coding agent that edits files via tool calls." },
    { role: "user", content: envelope.prompt },
  ];

  let lastAssistant = "";
  let lastReadPath: string | null = null;
  let httpOk = true;
  let timedOut = false;
  let iters = 0;

  while (iters < maxIters && Date.now() - start < wallMs) {
    iters++;
    let reply: string;
    try {
      reply = await chat(messages, Math.max(2000, wallMs - (Date.now() - start)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/aborted|timeout/i.test(msg)) timedOut = true;
      httpOk = false;
      lastAssistant = msg;
      break;
    }
    lastAssistant = reply;
    messages.push({ role: "assistant", content: reply });

    const calls = parseToolCalls(reply);
    if (calls.length === 0) break; // чистый текст — конец работы

    for (const call of calls) {
      // Дедуп read_file того же пути подряд.
      if (call.name === "read_file" && call.args.path === lastReadPath) {
        messages.push({ role: "tool", content: "(already read, see above)" });
        continue;
      }
      if (call.name === "read_file") lastReadPath = call.args.path ?? null;
      try {
        const result = await executeTool(call, opts.cwd);
        messages.push({ role: "tool", content: result });
      } catch (e) {
        messages.push({ role: "tool", content: `(error: ${e instanceof Error ? e.message : e})` });
      }
    }
  }

  if (iters >= maxIters && parseToolCalls(lastAssistant).length > 0) {
    // вышли по лимиту итераций, ещё зовёт tools
  }

  const output = truncate(lastAssistant.trim());
  const hasOutput = output.length > 0;
  const hasChanges = needsEdits ? await gitHasChanges(opts.cwd) : null;

  const signals: WorkerResult["signals"] = [
    { name: "exit_0", ok: httpOk, detail: httpOk ? "http 200" : "http error" },
    { name: "nonempty_output", ok: hasOutput, detail: `${output.length} chars` },
  ];
  if (needsEdits) {
    signals.push({ name: "files_changed", ok: hasChanges === true, detail: hasChanges ? "yes" : "no" });
  }

  let reason: WorkerResult["reason"] = null;
  if (timedOut) reason = "timeout";
  else if (!httpOk) reason = "error";
  else if (!hasOutput) reason = "no_output";
  else if (needsEdits && !hasChanges) reason = "no_changes";

  const success = signals.every((s) => s.ok);

  return {
    exit_ok: httpOk,
    exit_code: httpOk ? 0 : 1,
    output,
    timed_out: timedOut,
    has_output: hasOutput,
    has_changes: hasChanges,
    signals,
    success,
    reason,
    stderr: httpOk ? "" : truncate(lastAssistant),
    duration_ms: Date.now() - start,
  };
};

export default runOllama;
```

- [ ] **Step 3: Register in `workers/index.ts`**

```ts
import { runOllama } from "./runOllama.ts";

export const WORKERS: Record<AgentName, WorkerFn> = {
  claude: runClaude,
  codex: runCodex,
  glm: runGlm,
  ollama: runOllama,
};

// update exports
export { runClaude, runCodex, runGlm, runOllama };
```

- [ ] **Step 4: Smoke test against real Ollama (network)**

Run: `OLLAMA_BASE_URL=http://d0nlebed0n.tail74ba62.ts.net:11434 npx tsx -e "
import { runOllama } from './src/workers/runOllama.ts';
const r = await runOllama(
  { id: 'T', agent: 'ollama', family: 'local', role: 'implement',
    prompt: 'Create file hello.ts exporting function add(a,b) returning a+b. Use write_file.',
    target_paths: ['hello.ts'], context: null, effort: 'low', allow_same_family: false,
    budget: { wall_time_sec: 120, max_steps: 2 } },
  { cwd: '/tmp/ollama-smoke' },
);
console.log(JSON.stringify({ success: r.success, has_changes: r.has_changes, reason: r.reason, signals: r.signals }, null, 2));
"`
Prepare cwd first: `mkdir -p /tmp/ollama-smoke && cd /tmp/ollama-smoke && git init -q`.
Expected: `success: true`, `has_changes: true`, `hello.ts` created.

- [ ] **Step 5: typecheck + commit**

Run: `npx tsc --noEmit` → exit 0.

```bash
git add src/prompts/roles.ts src/workers/runOllama.ts src/workers/index.ts
git commit -m "feat(workers): runOllama tool-loop worker + ollama role prompt"
```

---

### Task 7: Health check for ollama

**Files:**
- Modify: `src/workers/health.ts`

**Interfaces:**
- Produces: `checkOllama()` pings `OLLAMA_BASE_URL/api/tags`; `checkHealth` switch gains `case "ollama"`; `checkHealthForAgents` forwards an `ollamaEnv` (or reads process.env directly).

- [ ] **Step 1: Add `checkOllama`**

In `src/workers/health.ts`, add (reading env directly — the runner sets them before health):

```ts
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://d0nlebed0n.tail74ba62.ts.net:11434";

async function checkOllama(): Promise<HealthResult> {
  const checks: HealthResult["checks"] = [];
  // 1. base url set
  checks.push({
    name: "base_url",
    ok: !!OLLAMA_BASE_URL,
    detail: OLLAMA_BASE_URL,
  });
  // 2. /api/tags reachable
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: "GET" });
    const ok = res.ok;
    let detail = `HTTP ${res.status}`;
    if (ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);
      detail = `reachable, ${names.length} model(s)`;
    }
    checks.push({ name: "reachable", ok, detail });
  } catch (e) {
    checks.push({ name: "reachable", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  const healthy = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  return {
    agent: "ollama",
    healthy,
    checks,
    reason: healthy ? null : failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
  };
}
```

- [ ] **Step 2: Wire into `checkHealth` switch**

```ts
export async function checkHealth(agent: AgentName, glmEnv?: Record<string, string>): Promise<HealthResult> {
  switch (agent) {
    case "claude":
      return checkClaude();
    case "codex":
      return checkCodex();
    case "glm":
      return checkGlm(glmEnv);
    case "ollama":
      return checkOllama();
  }
}
```

- [ ] **Step 3: Verify**

Run: `OLLAMA_BASE_URL=http://d0nlebed0n.tail74ba62.ts.net:11434 npx tsx -e "
import { checkHealth } from './src/workers/health.ts';
const r = await checkHealth('ollama');
console.log(JSON.stringify(r, null, 2));
"`
Expected: `healthy: true`, `reachable: reachable, N model(s)`.

Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/workers/health.ts
git commit -m "feat(health): ollama health check (/api/tags ping)"
```

---

### Task 8: `runBounded` concurrency helper

**Files:**
- Modify: `src/runner.ts` (add helper at top)
- Create: `scripts/smoke-bounded.ts`

**Interfaces:**
- Produces: `runBounded<T,U>(items: T[], maxParallel: number, fn: (item: T, i: number) => Promise<U>): Promise<U[]>` — never launches more than `maxParallel` concurrently.

- [ ] **Step 1: Write failing test**

Create `scripts/smoke-bounded.ts`:

```ts
import { runBounded } from "../src/runner.ts";
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}
let active = 0, maxObserved = 0;
const items = Array.from({ length: 10 }, (_, i) => i);
const out = await runBounded(items, 3, async (n) => {
  active++; maxObserved = Math.max(maxObserved, active);
  await new Promise((r) => setTimeout(r, 10));
  active--;
  return n * 2;
});
assert(maxObserved <= 3, `max concurrency 3 (observed ${maxObserved})`);
assert(out.length === 10 && out[2] === 4, "results in order");
assert(maxObserved >= 2, "actually ran in parallel");
console.log("\nAll bounded checks passed.");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-bounded.ts` → FAIL (not exported).

- [ ] **Step 3: Implement `runBounded` in `runner.ts`**

Add near the top of `src/runner.ts` (after imports):

```ts
/** Ограниченный пул конкурентности: не больше maxParallel одновременно. Сохраняет порядок результатов. */
export async function runBounded<T, U>(
  items: T[],
  maxParallel: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.max(1, Math.min(maxParallel, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
```

- [ ] **Step 4: Run tests until green**

Run: `npx tsx scripts/smoke-bounded.ts` → all ✓.
Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts scripts/smoke-bounded.ts
git commit -m "feat(runner): runBounded concurrency helper"
```

---

### Task 9: Decompose `runStep` — extract worker execution + commit (no merge) helpers

This task refactors the existing `runStep` into reusable pieces WITHOUT changing behavior of linear workflows. Fan-out (Task 10) then composes these pieces.

**Files:**
- Modify: `src/runner.ts`

**Interfaces:**
- Produces:
  - `runWorkerOnly(taskId, step, stepIdx, prompt, projectPath, glmEnv, breaker, allSteps, opts)` → `{ result, stepId, output }` — does worktree setup (for editing roles) + circuit check + worker + retries + writeResult + checkpoint + breaker + step record. Does NOT merge. Returns the worktree handle if one was created (so caller can commit/merge/cleanup).
  - `commitStep(wt, envelope)` — wraps `commitAllInWorktree`.
  - `runStep` stays as the linear entry point but delegates: `runWorkerOnly` → commit → merge → cleanup (existing logic preserved).

- [ ] **Step 1: Extract `runWorkerOnly` from `runStep`**

In `src/runner.ts`, refactor. The current `runStep` body (lines ~123-340) splits into:
- `runWorkerOnly`: everything from stepId computation through the `try/catch/finally` that records the step + writes result + checkpoint + breaker. It also creates the worktree for editing roles and returns `{ result, stepId, output, wt, cwd }`. It accepts an optional `subtaskSuffix` and optional `cwdOverride` + `deferWorktree` flags.
- `runStep` (linear): calls `runWorkerOnly`, then if `wt && result.success`: commit + merge + removeWorktree (unchanged from today).

Concretely, add an options type and extract. New signature:

```ts
interface WorkerOnlyOpts {
  iteration?: number;
  subtaskSuffix?: string;          // "~P1" / "~P1r"
  cwdOverride?: string;            // run in this cwd instead of creating a worktree (candidate review)
  skipWorktree?: boolean;          // review-in-candidate: no new worktree, use cwdOverride
}

async function runWorkerOnly(
  taskId: string,
  step: ResolvedStep,
  stepIdx: number,
  prompt: string,
  projectPath: string,
  glmEnv: Record<string, string> | undefined,
  breaker: CircuitBreaker,
  allSteps: ResolvedStep[],
  o: WorkerOnlyOpts = {},
): Promise<{ result: WorkerResult; stepId: string; output: string; wt: WorktreeHandle | null; cwd: string }> {
  const iteration = o.iteration ?? 1;
  const baseStepId = newStepId(taskId, stepIdx + 1, iteration);
  const stepId = o.subtaskSuffix ? `${baseStepId}${o.subtaskSuffix}` : baseStepId;

  const context =
    o.cwdOverride === undefined
      ? await contextFromPrevStep(taskId, step, allSteps, iteration)
      : null; // review-in-candidate: context injected by caller via prompt already

  let wt: WorktreeHandle | null = null;
  let cwd = o.cwdOverride ?? projectPath;
  if (!o.skipWorktree && !o.cwdOverride) {
    if (["implement", "refine", "fix"].includes(step.role)) {
      const branchAgent = o.subtaskSuffix ? `${step.agent}${o.subtaskSuffix}` : step.agent;
      wt = await createWorktree(projectPath, taskId, branchAgent);
      cwd = wt.path;
    } else if (["review", "final"].includes(step.role)) {
      // линейный review/final — в integration-worktree (как раньше)
      // NB: при fan-out это не вызывается (caller передаёт cwdOverride)
      cwd = projectPath; // placeholder — linear path sets integrationWtPath via a param (see Step 2)
    }
  }

  // ... остальной код (envelope, breaker check, upsertStep running, worker+retries,
  //     writeResult, checkpoint, breaker record, finally upsertStep) — без изменений,
  //     но использует stepId и cwd из этого замыкания.
  // Возвращает { result, stepId, output, wt, cwd }.
}
```

NOTE: the linear review/final path needs `integrationWtPath`. Rather than thread it through `runWorkerOnly`, keep the integration-merge logic for review/final INSIDE `runStep` (linear) before calling `runWorkerOnly` with `cwdOverride: integrationWtPath`. That is: `runStep` decides cwd for review/final (sets it to integrationWtPath + does the ff-only merge), then passes `cwdOverride` so `runWorkerOnly` doesn't create a worktree.

- [ ] **Step 2: Rewrite `runStep` (linear) to use `runWorkerOnly` + integration cwd**

```ts
async function runStep(
  taskId: string,
  step: ResolvedStep,
  stepIdx: number,
  prompt: string,
  projectPath: string,
  integrationWtPath: string,
  glmEnv: Record<string, string> | undefined,
  breaker: CircuitBreaker,
  allSteps: ResolvedStep[],
  iteration = 1,
  contextOverride?: string | null,
): Promise<StepRun> {
  // review/final: работают в integration-worktree
  let cwdOverride: string | undefined;
  if (["review", "final"].includes(step.role)) {
    await git(integrationWtPath, ["merge", "--ff-only", integrationBranch(taskId)]).catch(() => {});
    cwdOverride = integrationWtPath;
  }

  const { result, stepId, output, wt } = await runWorkerOnly(
    taskId, step, stepIdx, prompt, projectPath, glmEnv, breaker, allSteps,
    { iteration, cwdOverride, ...(contextOverride !== undefined ? {} : {}) },
  );

  // context override применяется только для plan в loop (2+ круг) — добавим в runWorkerOnly
  // через опцию contextOverride (см. Step 3 refinement).

  // Merge worktree в integration после успеха (линейный путь).
  if (wt && result.success) {
    const committed = await commitAllInWorktree(wt, `orch(${step.agent}/${step.role}): ${stepId}`);
    if (!committed) {
      await logEvent({ task_id: taskId, step_id: stepId, level: "warn", kind: "no_changes_to_commit",
        message: `step ${step.role} (${step.agent}) succeeded but made no file changes` });
    }
    const mergeRes = await mergeWorktree(integrationWtPath, wt);
    if (!mergeRes.ok) {
      await escalateHitl({ task_id: taskId, step_id: stepId,
        reason: mergeRes.conflict ? "merge conflict" : "merge error", detail: { message: mergeRes.message } });
    }
    await removeWorktree(projectPath, wt);
  }
  return { result, stepId, output };
}
```

- [ ] **Step 3: Thread `contextOverride` through `runWorkerOnly`**

Add `contextOverride?: string | null` to `WorkerOnlyOpts`; in `runWorkerOnly` compute context as:
```ts
const context = o.contextOverride !== undefined ? o.contextOverride
  : o.cwdOverride === undefined ? await contextFromPrevStep(taskId, step, allSteps, iteration) : null;
```
Pass it from `runStep`:
```ts
{ iteration, cwdOverride, contextOverride },
```

- [ ] **Step 4: Verify linear workflows still work**

Run all existing smoke + typecheck:
```bash
npx tsc --noEmit
npx tsx scripts/smoke-units.ts
npx tsx scripts/smoke.ts
npx tsx scripts/smoke-loop.ts
```
Expected: all pass, exit 0. (No behavior change for linear paths.)

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts
git commit -m "refactor(runner): decompose runStep into runWorkerOnly + commit + merge"
```

---

### Task 10: Fan-out runtime in `runWorkflow` (two-phase merge)

The core task. Implements Phase A (parallel implement, no merge) + Phase B (sequential candidate merge + review + promote), routing, verdicts, aggregation, health-gate fix, cleanup-on-partial-failure exception.

**Files:**
- Modify: `src/runner.ts`
- Modify: `src/worktree.ts` (add `createCandidateWorktree` + `promoteCandidateToIntegration`)
- Create: `scripts/smoke-fanout-mock.ts` (mocked workers — no network needed for protocol test)

**Interfaces:**
- Consumes: `runBounded`, `runWorkerOnly`, `routeSubtask`, `pathsOverlap`, `parsePlan`, `newSubtaskStepId`, worktree helpers.
- Produces: a `runFanOut(...)` function called from `runWorkflow` when a level contains a fan_out step.

- [ ] **Step 1: Add candidate worktree helpers to `worktree.ts`**

```ts
/**
 * Создать disposable candidate-ветку + worktree от текущей integration.
 * Для фазы B fan-out: туда мержится одна implement-ветка, там идёт review,
 * и только при APPROVE candidate продвигается в integration.
 */
export async function createCandidateWorktree(
  projectPath: string,
  taskId: string,
  subtaskId: string,
): Promise<{ branch: string; worktreePath: string }> {
  const integration = integrationBranch(taskId);
  const branch = `orch/${taskId}/cand-${subtaskId}`;
  const wtPath = await mkdtemp(join(tmpdir(), `orch-${taskId}-cand-${subtaskId}-`));
  try {
    await git(projectPath, ["branch", branch, integration]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists|exists/.test(msg)) throw e;
  }
  await git(projectPath, ["worktree", "add", wtPath, branch]);
  return { branch, worktreePath: wtPath };
}

/** Продвинуть candidate в integration: ff integration → candidate, затем cleanup candidate. */
export async function promoteCandidateToIntegration(
  projectPath: string,
  taskId: string,
  candidate: { branch: string; worktreePath: string },
): Promise<{ ok: boolean; message: string }> {
  const integration = integrationBranch(taskId);
  try {
    // Переключим integration-ветку на candidate через временный integration-worktree.
    // Простейший детерминизм: git branch -f integration candidate (если integration не checked out).
    await git(projectPath, ["branch", "-f", integration, candidate.branch]);
    // cleanup candidate worktree + branch
    await git(projectPath, ["worktree", "remove", "--force", candidate.worktreePath]).catch(() => {});
    await rm(candidate.worktreePath, { recursive: true, force: true }).catch(() => {});
    await git(projectPath, ["branch", "-D", candidate.branch]).catch(() => {});
    return { ok: true, message: `integration fast-forwarded to ${candidate.branch.slice(-12)}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Удалить disposable candidate (без продвижения) — при REJECT/REQUEST_CHANGES. */
export async function discardCandidate(
  projectPath: string,
  candidate: { branch: string; worktreePath: string },
): Promise<void> {
  await git(projectPath, ["worktree", "remove", "--force", candidate.worktreePath]).catch(() => {});
  await rm(candidate.worktreePath, { recursive: true, force: true }).catch(() => {});
  await git(projectPath, ["branch", "-D", candidate.branch]).catch(() => {});
}
```

- [ ] **Step 2: Implement `runFanOut` in `runner.ts`**

Add (imports: `parsePlan`, `routeSubtask`, `pathsOverlap`, `newSubtaskStepId`, `createCandidateWorktree`, `promoteCandidateToIntegration`, `discardCandidate`, `commitAllInWorktree`, `mergeWorktree` already imported):

```ts
interface FanOutOutcome {
  allApproved: boolean;
  failedSubtasks: string[];
}

async function runFanOut(
  taskId: string,
  spec: FanOutSpec,
  allSteps: ResolvedStep[],
  prompt: string,
  projectPath: string,
  integrationWtPath: string,
  glmEnv: Record<string, string> | undefined,
  ollamaEnv: Record<string, string> | undefined,
  breaker: CircuitBreaker,
  threshold: number,
  maxParallel: number,
): Promise<FanOutOutcome> {
  const stepIdx = allSteps.indexOf(spec.step);
  const planStepIdx = allSteps.findIndex((s) => s.id === spec.fromPlanId);
  const planStepId = newStepId(taskId, planStepIdx + 1, 1);
  const planResult = await readResult(taskId, planStepId);
  if (!planResult || typeof planResult !== "object" || !("output" in planResult)) {
    await escalateHitl({ task_id: taskId, step_id: planStepId, reason: "fan_out: plan result missing", detail: {} });
    return { allApproved: false, failedSubtasks: ["(no plan)"] };
  }
  const planOutput = String((planResult as { output: string }).output);
  let plan: SubtaskPlan;
  try {
    plan = parsePlan(planOutput);
  } catch (e) {
    await escalateHitl({ task_id: taskId, step_id: planStepId, reason: "fan_out: parsePlan failed",
      detail: { error: e instanceof Error ? e.message : String(e) } });
    return { allApproved: false, failedSubtasks: ["(bad plan)"] };
  }

  // Маршрутизация + проверка пересечения target_paths.
  type Routed = { subtask: Subtask; agent: AgentName };
  const routed: Routed[] = [];
  const failed: string[] = [];
  for (const subtask of plan.subtasks) {
    try {
      const agent = routeSubtask(subtask, spec.agents, threshold);
      routed.push({ subtask, agent });
    } catch (e) {
      failed.push(subtask.id);
      await escalateHitl({ task_id: taskId, step_id: null,
        reason: `fan_out: subtask ${subtask.id} unroutable`, detail: { error: e instanceof Error ? e.message : String(e) } });
    }
  }
  // target_paths пересечение (строгий v1)
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      if (pathsOverlap(routed[i]!.subtask.target_paths, routed[j]!.subtask.target_paths)) {
        await escalateHitl({ task_id: taskId, step_id: null,
          reason: `fan_out: target_paths overlap between ${routed[i]!.subtask.id} and ${routed[j]!.subtask.id}`,
          detail: { a: routed[i]!.subtask.target_paths, b: routed[j]!.subtask.target_paths } });
        return { allApproved: false, failedSubtasks: ["(path overlap)"] };
      }
    }
  }

  // ── Фаза A: implement параллельно (без merge). ──
  type PhaseAResult = { subtask: Subtask; agent: AgentName; result: WorkerResult; stepId: string; wt: WorktreeHandle | null };
  const phaseA: (PhaseAResult | null)[] = await runBounded(routed, maxParallel, async ({ subtask, agent }) => {
    if (breaker.isTripped(agent)) {
      await escalateHitl({ task_id: taskId, step_id: null, reason: `circuit breaker tripped on '${agent}' for subtask ${subtask.id}`, detail: {} });
      failed.push(subtask.id);
      return null;
    }
    const implStep: ResolvedStep = { ...spec.step, agent, agentName: agent, family: AGENTS[agent].family, target_paths: subtask.target_paths };
    const envFor = agent === "ollama" ? ollamaEnv : agent === "glm" ? glmEnv : undefined;
    const { result, stepId, wt } = await runWorkerOnly(
      taskId, implStep, stepIdx, `${subtask.goal}\n\nACCEPTANCE CRITERIA: ${subtask.acceptance_criteria}`,
      projectPath, envFor, breaker, allSteps, { subtaskSuffix: `~${subtask.id}` },
    );
    // Коммитим (чтобы изменения ушли в ветку), но НЕ мержим.
    if (wt && result.success) {
      await commitAllInWorktree(wt, `orch(${agent}/implement): ${stepId}`);
    }
    if (!result.success) failed.push(subtask.id);
    return { subtask, agent, result, stepId, wt };
  });

  // ── Фаза B: candidate merge + review — строго последовательно. ──
  let allApproved = true;
  const summaries: string[] = [];
  for (const item of phaseA) {
    if (!item || !item.result.success || !item.wt) {
      if (item) summaries.push(`- ${item.subtask.id}: FAILED (implement)`);
      allApproved = false;
      // cleanup worktree провалившейся
      if (item?.wt) await removeWorktree(projectPath, item.wt);
      continue;
    }
    if (!spec.review) {
      // без review — мержим сразу
      const mr = await mergeWorktree(integrationWtPath, item.wt);
      if (!mr.ok) { failed.push(item.subtask.id); allApproved = false; }
      await removeWorktree(projectPath, item.wt);
      summaries.push(`- ${item.subtask.id}: MERGED (no review)`);
      continue;
    }
    // candidate от integration + merge implement-ветки
    const candidate = await createCandidateWorktree(projectPath, taskId, item.subtask.id);
    const cm = await mergeWorktree(candidate.worktreePath, item.wt);
    if (!cm.ok) {
      await discardCandidate(projectPath, candidate);
      await removeWorktree(projectPath, item.wt);
      failed.push(item.subtask.id); allApproved = false;
      summaries.push(`- ${item.subtask.id}: FAILED (candidate merge conflict)`);
      continue;
    }
    // diff guard: проверка, что правки в target_paths
    const { stdout: names } = await git(candidate.worktreePath, ["diff", "--name-only", integrationBranch(taskId), candidate.branch]).catch(() => ({ stdout: "" }));
    const changed = names.trim().split("\n").filter(Boolean);
    const outOfScope = changed.filter((f) => {
      const tp = item.subtask.target_paths;
      if (tp.length === 0) return false;
      return !tp.some((p) => f === p || f.startsWith(p + "/") || p.startsWith(f + "/"));
    });
    if (outOfScope.length > 0) {
      await escalateHitl({ task_id: taskId, step_id: null, reason: `fan_out: subtask ${item.subtask.id} diff out of target_paths`, detail: { outOfScope, target_paths: item.subtask.target_paths } });
      await discardCandidate(projectPath, candidate);
      await removeWorktree(projectPath, item.wt);
      failed.push(item.subtask.id); allApproved = false;
      summaries.push(`- ${item.subtask.id}: FAILED (diff out of scope)`);
      continue;
    }
    // review в candidate
    const reviewStep: ResolvedStep = { ...spec.step, agent: "codex", agentName: "codex", family: AGENTS.codex.family, role: "review" };
    const rr = await runWorkerOnly(
      taskId, reviewStep, stepIdx, buildReviewPrompt(item.subtask),
      projectPath, undefined, breaker, allSteps,
      { subtaskSuffix: `~${item.subtask.id}r`, cwdOverride: candidate.worktreePath, skipWorktree: true },
    );
    const verdict = await parseVerdict(taskId, rr.stepId);
    if (verdict === "APPROVE" || verdict === "ACCEPT") {
      await promoteCandidateToIntegration(projectPath, taskId, candidate);
      summaries.push(`- ${item.subtask.id}: APPROVE (codex)`);
    } else {
      await discardCandidate(projectPath, candidate);
      failed.push(item.subtask.id); allApproved = false;
      summaries.push(`- ${item.subtask.id}: ${verdict ?? "no verdict"} → rejected`);
    }
    await removeWorktree(projectPath, item.wt);
  }

  // Агрегат под базовым stepId (для downstream: final с depends_on:[build]).
  const baseStepId = newStepId(taskId, stepIdx + 1, 1);
  await writeResult(taskId, baseStepId, {
    envelope_id: baseStepId, agent: "fan_out", role: spec.step.role,
    output: summaries.join("\n"), signals: [], success: allApproved,
    reason: allApproved ? null : "partial_failure", duration_ms: 0, timed_out: false,
  });

  return { allApproved, failedSubtasks: failed };
}

function buildReviewPrompt(subtask: Subtask): string {
  return `Review the implementation of this subtask in the current worktree (a candidate branch containing the implementer's changes merged on top of integration).

SUBTASK GOAL: ${subtask.goal}
ACCEPTANCE CRITERIA: ${subtask.acceptance_criteria}
TARGET PATHS: ${subtask.target_paths.join(", ") || "(none)"}

Use your normal review tools to read the diff and the files. Return your standard review format ending with VERDICT: APPROVE | REQUEST_CHANGES | REJECT.`;
}
```

- [ ] **Step 3: Wire fan-out into `runWorkflow`**

In `runWorkflow`, after computing `loaded`, resolve effective maxParallel and handle fanOuts. Insert fan-out handling inside the pre-loop section. Replace the pre-loop block so that: after running each preLevel normally, check if a `fanOut` exists whose `fromPlanId` is now satisfied (its plan step ran in an earlier level), then run `runFanOut`. Simplest correct approach given one fan_out: after the regular preLevels loop completes for non-fanout steps, run the (single) fanOut.

Add near top of `runWorkflow` (after `const loaded = ...`):
```ts
  const threshold = loaded.wf.complexity_threshold;
  const effectiveMaxParallel = opts.maxParallel ?? loaded.wf.max_parallel ?? 3;
  const ollamaEnv = opts.ollamaEnv;
```
Add to `RunOptions` interface: `ollamaEnv?: Record<string, string>;`.

Add `AGENTS` and `SubtaskPlan`/`Subtask` imports to runner. Add `createCandidateWorktree`, `promoteCandidateToIntegration`, `discardCandidate`, `writeResult` (already imported), `parsePlan`, `routeSubtask`, `pathsOverlap` imports.

After the existing pre-loop `for (const level of preLevels)` block, before the loop section, add:
```ts
  // ─── Fan-out (если есть) — после preLevels ──
  if (overallSuccess && loaded.fanOuts.length > 0) {
    for (const spec of loaded.fanOuts) {
      const fo = await runFanOut(
        taskId, spec, loaded.allSteps, opts.prompt, projectPath,
        integration.worktreePath, opts.glmEnv, opts.ollamaEnv, breaker,
        threshold, effectiveMaxParallel,
      );
      if (!fo.allApproved) overallSuccess = false;
    }
  }
```

Also fix health-gate (point #8): in the health section, replace `uniqueAgents`:
```ts
  const uniqueAgents = Array.from(new Set([
    ...loaded.allSteps.filter((s) => !s.fan_out).map((s) => s.agentName),
    ...loaded.fanOuts.flatMap((f) => f.agents),
  ]));
```
And extend the health call to pass ollama env awareness — `checkHealthForAgents` reads `process.env.OLLAMA_*` directly (the runner must have loaded them; see Task 11). Pass `glmEnv` as today.

- [ ] **Step 4: Cleanup-on-partial-failure exception (point #9)**

At the end of `runWorkflow`, the cleanup currently does `if (!overallSuccess) await removeIntegrationWorktree(...)`. For fan-out partial failure we keep the worktree. Track whether fan-out ran:
```ts
  const fanOutRan = loaded.fanOuts.length > 0;
  // ... after updateTask ...
  if (!overallSuccess && !fanOutRan) {
    await removeIntegrationWorktree(projectPath, integration.worktreePath);
  }
  // при fan-out частичном провале — НЕ удаляем (смерженные подзадачи нужны для разбора)
```

- [ ] **Step 5: Write protocol test with mocked workers (no network)**

This validates the two-phase protocol without hitting real models. We avoid `runWorkflow` (which calls real claude for plan/final) and instead test the pieces directly: `parsePlan` + `routeSubtask` + a mocked Phase A that writes a file, then verify candidate-merge + review-promote advances integration.

Create `scripts/smoke-fanout-mock.ts`:

```ts
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createCandidateWorktree, promoteCandidateToIntegration, discardCandidate, integrationBranch } from "../src/worktree.ts";
import { routeSubtask } from "../src/workflow.ts";
import type { Subtask } from "../src/plan.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// Тест 1: routeSubtask — ключевой контракт маршрутизации
const easy: Subtask = { id: "P1", title: "t", goal: "g", complexity: 20, target_paths: ["a.ts"], acceptance_criteria: "ok" };
const hard: Subtask = { id: "P2", title: "t", goal: "g", complexity: 90, target_paths: ["b.ts"], acceptance_criteria: "ok" };
assert(routeSubtask(easy, ["glm", "ollama"], 80) === "ollama", "easy → ollama");
assert(routeSubtask(hard, ["glm", "ollama"], 80) === "glm", "hard → glm");

// Тест 2: candidate lifecycle — продвижение интеграции (без моделей)
const root = mkdtempSync(join(tmpdir(), "fanout-mock-"));
const sh = (args: string[], cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" });
sh(["init", "-q"]);
sh(["config", "user.email", "t@t.t"]); sh(["config", "user.name", "t"]);
writeFileSync(join(root, "base.txt"), "base");
sh(["add", "-A"]); sh(["commit", "-q", "-m", "base"]);

const taskId = "T-MOCK";
// integration setup (mirror setupIntegration)
sh(["branch", integrationBranch(taskId), "main"]);
// simulate implement branch: ollama wrote a.ts
sh(["branch", `orch/${taskId}/ollama~P1`, integrationBranch(taskId)]);
sh(["checkout", "-q", `orch/${taskId}/ollama~P1`]);
writeFileSync(join(root, "a.ts"), "export const x = 1;");
sh(["add", "-A"]); sh(["commit", "-q", "-m", "impl P1"]);
sh(["checkout", "-q", "main"]);

// candidate from integration + merge implement branch
const candidate = await createCandidateWorktree(root, taskId, "P1");
// mergeWorktree would be called by runner; do it inline here
sh(["merge", "--no-ff", `orch/${taskId}/ollama~P1`, "-m", "candidate merge"], candidate.worktreePath);
assert(readFileSync(join(candidate.worktreePath, "a.ts"), "utf8") === "export const x = 1;", "candidate has impl file");

// promote → integration now points at candidate
const prom = await promoteCandidateToIntegration(root, taskId, candidate);
assert(prom.ok, "promote ok: " + prom.message);
// integration branch now contains a.ts
const intTree = sh(["rev-parse", integrationBranch(taskId)], root).trim();
const candTip = sh(["rev-parse", `orch/${taskId}/cand-P1`], root).trim();
// note: candidate branch deleted after promote; check integration log instead
const log = sh(["log", "--oneline", integrationBranch(taskId)], root);
assert(log.includes("candidate merge") || log.includes("impl P1"), "integration advanced with impl P1");

// cleanup
rmSync(root, { recursive: true, force: true });

console.log("\nAll fan-out protocol checks passed.");
```

Run: `npx tsx scripts/smoke-fanout-mock.ts` → all ✓.

- [ ] **Step 6: typecheck + commit**

```bash
npx tsc --noEmit
git add src/runner.ts src/worktree.ts scripts/smoke-fanout-mock.ts
git commit -m "feat(runner): fan-out two-phase merge (parallel implement, sequential candidate review)"
```

---

### Task 11: CLI + env wiring (`OLLAMA_*`, `--max-parallel`)

**Files:**
- Modify: `src/cli.ts`
- Modify: `.env.example`, `.env.local`

- [ ] **Step 1: Wire `OLLAMA_*` + `--max-parallel` in CLI**

In `src/cli.ts` parseArgs options add `max-parallel: { type: "string" }`. In the health section, read ollama env (it's read directly by health.ts from process.env, which dotenv already populated). In the run section add:
```ts
  const ollamaEnv: Record<string, string> = {};
  if (process.env.OLLAMA_BASE_URL) ollamaEnv.OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
  if (process.env.OLLAMA_MODEL) ollamaEnv.OLLAMA_MODEL = process.env.OLLAMA_MODEL;

  const maxParallel = values["max-parallel"] ? Number.parseInt(values["max-parallel"], 10) : undefined;

  const result = await runWorkflow({
    workflowPath, prompt, project,
    glmEnv: Object.keys(glmEnv).length > 0 ? glmEnv : undefined,
    ollamaEnv: Object.keys(ollamaEnv).length > 0 ? ollamaEnv : undefined,
    maxParallel,
  });
```

The runner passes `ollamaEnv` into `workerOpts.env` only for ollama steps — but `runWorkerOnly` currently passes `env` only for glm. Generalize: in `runWorkerOnly`, `const envFor = step.agent === "glm" ? glmEnv : step.agent === "ollama" ? ollamaEnv : undefined;` and `WorkerRunOptions.env = envFor`. (Update `runFanOut` already passes `envFor` correctly from Task 10.) Thread `ollamaEnv` through `runWorkflow` → `runStep`/`runWorkerOnly` for the linear ollama case too.

- [ ] **Step 2: Update `.env.example`**

```
# Ollama (local executor, optional — only for workflows using ollama steps)
OLLAMA_BASE_URL=http://d0nlebed0n.tail74ba62.ts.net:11434
OLLAMA_MODEL=danielsheep/Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS
```

Mirror into `.env.local` (without secrets — these are not secret).

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
ai-task --list   # decomposed shows up
ai-task --health # ollama checked when OLLAMA_BASE_URL set
```
Expected: `decomposed` listed; health shows `✓ ollama healthy` when env set.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts .env.example
git commit -m "feat(cli): OLLAMA_* env wiring + --max-parallel"
```

---

### Task 12: `decomposed.yaml` workflow + integration smoke

**Files:**
- Create: `workflows/decomposed.yaml`
- Create: `scripts/smoke-local.ts`

- [ ] **Step 1: Create the workflow**

Create `workflows/decomposed.yaml` (verbatim from spec):

```yaml
name: decomposed
description: |
  Claude декомпозирует → fan-out на glm (сложное) + ollama (простое),
  каждая подзадача независимо ревьётся codex.
complexity_threshold: 80
max_parallel: 3

steps:
  - id: plan
    agent: claude
    role: plan
    effort: high
    budget: { wall_time_sec: 900, max_steps: 2 }
    depends_on: []

  - id: build
    fan_out: true
    from_plan: plan
    agents: [glm, ollama]
    review: true
    role: implement
    depends_on: [plan]
    budget: { wall_time_sec: 1200, max_steps: 2 }

  - id: final
    agent: claude
    role: final
    effort: high
    budget: { wall_time_sec: 900, max_steps: 2 }
    depends_on: [build]
```

Also add a JSON-output instruction to the plan prompt so Claude emits the `SubtaskPlan` shape (Task 3's `parsePlan` expects it). Update `planPrompt` in `roles.ts` to require the JSON envelope when the workflow uses fan-out — but the prompt is role-level, not workflow-aware. Simplest: add a fan-out-specific note. Since `decomposed` is the only fan-out consumer, append to `planPrompt`:

```ts
"OUTPUT FORMAT FOR DECOMPOSED WORKFLOWS (strict JSON — the runner parses it):",
"Return ONLY a JSON object (optionally in a ```json fence):",
'{ "subtasks": [ { "id": "P1", "title": "...", "goal": "...", "complexity": 0-100, "target_paths": ["..."], "acceptance_criteria": "..." } ] }',
"complexity: 0=trivial (single fn, 1-2 files), 100=architectural (multiple modules).",
```
(Place this inside `planPrompt` REQUIREMENTS; keep the markdown format as a fallback for non-fanout workflows.)

- [ ] **Step 2: Create `scripts/smoke-local.ts`**

Validates: (a) workflow loads + compiles; (b) `runOllama` reachable; (c) health for ollama. Network-dependent — gate behind a clear message.

```ts
import { loadWorkflow } from "../src/runner.ts";
import { join } from "node:path";
import { checkHealth } from "../src/workers/health.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const wf = await loadWorkflow(join(process.cwd(), "workflows/decomposed.yaml"));
assert(wf.fanOuts.length === 1, "decomposed has 1 fan_out");
assert(wf.fanOuts[0]!.agents.includes("ollama"), "fan_out includes ollama");
assert(wf.wf.complexity_threshold === 80, "threshold 80");

const h = await checkHealth("ollama");
if (!h.healthy) { console.error("✗ ollama not reachable — set OLLAMA_BASE_URL"); process.exit(1); }
console.log("✓ ollama reachable:", h.checks[1]?.detail);
console.log("\nAll local-executor checks passed.");
```

- [ ] **Step 3: Run**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-local.ts
ai-task --list
```
Expected: smoke-local ✓; `decomposed` listed.

- [ ] **Step 4: Commit**

```bash
git add workflows/decomposed.yaml scripts/smoke-local.ts src/prompts/roles.ts
git commit -m "feat: decomposed workflow + local-executor smoke"
```

---

## Final verification

- [ ] `npx tsc --noEmit` → exit 0
- [ ] `npx tsx scripts/smoke-units.ts` → all ✓ (incl. new ollama/local asserts)
- [ ] `npx tsx scripts/smoke-stepid.ts` → all ✓
- [ ] `npx tsx scripts/smoke-plan.ts` → all ✓
- [ ] `npx tsx scripts/smoke-workflow.ts` → all ✓
- [ ] `npx tsx scripts/smoke-ollama-tools.ts` → all ✓
- [ ] `npx tsx scripts/smoke-bounded.ts` → all ✓
- [ ] `npx tsx scripts/smoke-fanout-mock.ts` → all ✓ (protocol, no network)
- [ ] `npx tsx scripts/smoke.ts` + `smoke-loop.ts` → all ✓ (no regression)
- [ ] `npx tsx scripts/smoke-local.ts` → all ✓ (network: ollama)
- [ ] `ai-task --list` shows `decomposed`
- [ ] `ai-task --health` shows ollama healthy

## Notes for the implementer

- **Task 9 is the riskiest refactor.** Its only goal is to split `runStep` WITHOUT changing linear behavior. If `smoke.ts`/`smoke-loop.ts` regress, the split is wrong — fix before Task 10.
- **Task 10 Phase B is sequential by design** — do not parallelize candidate merges (integration HEAD race).
- **`git branch -f integration candidate`** in `promoteCandidateToIntegration` is safe only because integration is never checked out in the user's main repo (it lives in the integration-worktree). If that assumption ever changes, switch to a merge into integration-worktree + ff.
- The spec's 12-point inconsistency checklist (in the spec doc) is the acceptance criterion — each point must have a corresponding test or be visibly handled.
