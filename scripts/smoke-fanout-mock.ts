/**
 * smoke-fanout-mock — протокольный тест fan-out БЕЗ моделей (Task 10, Step 5).
 *
 * Валидирует git-механику двухфазного merge и маршрутизацию, не трогая сеть/CLI:
 *   1. routeSubtask — ключевой контракт маршрутизации (complexity vs threshold).
 *   2. pathsOverlap / partition — контракт ограничений запуска.
 *   3. candidate lifecycle: create → merge implement → promote → integration продвинута (ff).
 *   4. discard: candidate выброшен, integration НЕ продвинута, ветки зачищены.
 *   5. два последовательных candidate-merge не дают гонки (integration ff-цепочка).
 *
 * Реальные воркеры не запускаются — правки «исполнителя» симулируются прямым write+commit.
 * Запуск: npx tsx scripts/smoke-fanout-mock.ts
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createCandidateWorktree,
  promoteCandidateToIntegration,
  discardCandidate,
  setupIntegration,
  removeIntegrationWorktree,
  integrationBranch,
} from "../src/worktree.ts";
import { routeSubtask, pathsOverlap, buildLoadedWorkflow, WorkflowSchema } from "../src/workflow.ts";
import type { Subtask } from "../src/plan.ts";
import { loadModelsConfig } from "../src/model-registry.ts";
import { BLACKBOARD_DIR } from "../src/blackboard.ts";

// review #10: routeSubtask → getAgentFamily требует инициализированный registry.
const regRoot = mkdtempSync(join(tmpdir(), "orch-smoke-fanout-"));
loadModelsConfig(join(regRoot, BLACKBOARD_DIR));

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("✗ " + msg);
    process.exit(1);
  }
  console.log("✓ " + msg);
}

// ─── Тест 1: routeSubtask — ключевой контракт маршрутизации ─────────────────
const easy: Subtask = { id: "P1", title: "t", goal: "g", complexity: 20, target_paths: ["a.ts"], acceptance_criteria: "ok" };
const hard: Subtask = { id: "P2", title: "t", goal: "g", complexity: 90, target_paths: ["b.ts"], acceptance_criteria: "ok" };
assert(routeSubtask(easy, ["glm", "ollama"], 80) === "ollama", "easy (complexity 20) → ollama (local)");
assert(routeSubtask(hard, ["glm", "ollama"], 80) === "glm", "hard (complexity 90) → glm (strong)");
// easy-задача без local-агента в пуле → routeSubtask бросает (нет подходящей семьи).
let threw = false;
try {
  routeSubtask(easy, ["claude", "codex", "glm"], 80);
} catch {
  threw = true;
}
assert(threw, "easy without local agent → routeSubtask throws");

// ─── Тест 2: partition — final после fan_out (а не параллельно с plan) ──────
assert(pathsOverlap(["a.ts"], ["a.ts"]), "same path overlaps (launch guard would HITL)");
assert(!pathsOverlap(["a.ts"], ["b.ts"]), "distinct paths don't overlap (parallel safe)");

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
const preIds = loaded.preLevels.flat().map((s) => s.id);
const postFanOutIds = loaded.postFanOutLevels.flat().map((s) => s.id);
assert(preIds.includes("plan") && !preIds.includes("final"), "plan before fan-out; final NOT in preLevels");
assert(postFanOutIds.includes("final"), "final deferred to postFanOutLevels (runs after fan-out)");

// ─── Тест 3: candidate lifecycle — продвижение integration (без моделей) ───
// Симулируем: integration-ветка от main; implement-ветка ollama~P1 с правкой a.ts;
// candidate от integration + merge implement → promote → integration продвинута.
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fanout-mock-"));
  const sh = (args: string[], cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" });
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.email", "t@t.t"]);
  sh(["config", "user.name", "t"]);
  writeFileSync(join(root, "base.txt"), "base");
  sh(["add", "-A"]);
  sh(["commit", "-q", "-m", "base"]);
  return root;
}

function gitSha(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// --- сценарий APPROVE: promote продвигает integration ---
// ВАЖНО: как и реальный раннер (setupIntegration), держим integration-WORKTREE
// открытым на протяжении всего сценария. Это и есть РЕАЛЬНОЕ ограничение, на
// котором валится `git branch -f` (git запрещает force-update ветки, checked out
// в любом worktree). Старый smoke этого не делал — отсюда ложная уверенность.
const root1 = freshRepo();
const taskId = "T-MOCK";
const integration1 = await setupIntegration(root1, taskId, "main");
// implement-ветка: ollama написал a.ts (симуляция Phase A: commit без merge).
// Имя ветки: '.' вместо '~' (git ref-format не допускает '~'); stepId при этом
// использует '~' (это имя файла, не ref). См. runWorkerOnly branchAgent-санитацию.
const implBranch = `orch/${taskId}/ollama.P1`;
execFileSync("git", ["branch", implBranch, integrationBranch(taskId)], { cwd: root1, encoding: "utf8" });
execFileSync("git", ["checkout", "-q", implBranch], { cwd: root1, encoding: "utf8" });
writeFileSync(join(root1, "a.ts"), "export const x = 1;");
execFileSync("git", ["add", "-A"], { cwd: root1, encoding: "utf8" });
execFileSync("git", ["commit", "-q", "-m", "impl P1"], { cwd: root1, encoding: "utf8" });
execFileSync("git", ["checkout", "-q", "main"], { cwd: root1, encoding: "utf8" });

const integrationBefore = gitSha(["rev-parse", integrationBranch(taskId)], root1);
// Phase B: candidate от integration + merge implement-ветки в candidate-worktree.
const candidate = await createCandidateWorktree(root1, taskId, "P1");
// mergeWorktree раннер вызвал бы сам; здесь делаем inline (как делает mergeWorktree).
execFileSync("git", ["merge", "--no-ff", implBranch, "-m", "candidate merge"], { cwd: candidate.worktreePath, encoding: "utf8" });
assert(readFileSync(join(candidate.worktreePath, "a.ts"), "utf8") === "export const x = 1;", "candidate worktree has impl file after merge");

// promote → integration продвинута ЧЕРЕЗ integration-worktree (ff-only merge).
const prom = await promoteCandidateToIntegration(root1, taskId, candidate, integration1.worktreePath);
assert(prom.ok, "promote ok: " + prom.message);
const integrationAfter = gitSha(["rev-parse", integrationBranch(taskId)], root1);
assert(integrationAfter !== integrationBefore, "integration advanced after promote");
// integration теперь содержит a.ts (проверим через show).
const aContent = execFileSync("git", ["show", `${integrationBranch(taskId)}:a.ts`], { cwd: root1, encoding: "utf8" }).trim();
assert(aContent === "export const x = 1;", "integration contains merged a.ts");
// candidate worktree удалён.
assert(!existsSync(candidate.worktreePath), "candidate worktree removed after promote");
// cleanup integration-worktree этого сценария.
await removeIntegrationWorktree(root1, integration1.worktreePath);

// --- сценарий REJECT: discard НЕ продвигает integration ---
const root2 = freshRepo();
const taskId2 = "T-REJ";
const integration2 = await setupIntegration(root2, taskId2, "main");
const implBranch2 = `orch/${taskId2}/glm.P2`;
execFileSync("git", ["branch", implBranch2, integrationBranch(taskId2)], { cwd: root2, encoding: "utf8" });
execFileSync("git", ["checkout", "-q", implBranch2], { cwd: root2, encoding: "utf8" });
writeFileSync(join(root2, "b.ts"), "export const y = 2;");
execFileSync("git", ["add", "-A"], { cwd: root2, encoding: "utf8" });
execFileSync("git", ["commit", "-q", "-m", "impl P2"], { cwd: root2, encoding: "utf8" });
execFileSync("git", ["checkout", "-q", "main"], { cwd: root2, encoding: "utf8" });

const integrationBefore2 = gitSha(["rev-parse", integrationBranch(taskId2)], root2);
const candidate2 = await createCandidateWorktree(root2, taskId2, "P2");
execFileSync("git", ["merge", "--no-ff", implBranch2, "-m", "candidate merge"], { cwd: candidate2.worktreePath, encoding: "utf8" });
// REJECT → discard.
await discardCandidate(root2, candidate2);
const integrationAfter2 = gitSha(["rev-parse", integrationBranch(taskId2)], root2);
assert(integrationAfter2 === integrationBefore2, "integration NOT advanced after discard (REJECT)");
assert(!existsSync(candidate2.worktreePath), "candidate worktree removed after discard");
// candidate-ветка удалена.
const branches2 = execFileSync("git", ["branch", "--list"], { cwd: root2, encoding: "utf8" });
assert(!branches2.includes(`cand-P2`), "candidate branch deleted after discard");
await removeIntegrationWorktree(root2, integration2.worktreePath);

// --- сценарий два последовательных promote (P3, P4) — ff-цепочка без гонки ---
const root3 = freshRepo();
const taskId3 = "T-SEQ";
const integration3 = await setupIntegration(root3, taskId3, "main");
async function approveSubtask(subId: string, file: string, content: string): Promise<void> {
  const ib = `orch/${taskId3}/ollama.${subId}`;
  execFileSync("git", ["branch", ib, integrationBranch(taskId3)], { cwd: root3, encoding: "utf8" });
  execFileSync("git", ["checkout", "-q", ib], { cwd: root3, encoding: "utf8" });
  writeFileSync(join(root3, file), content);
  execFileSync("git", ["add", "-A"], { cwd: root3, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", `impl ${subId}`], { cwd: root3, encoding: "utf8" });
  execFileSync("git", ["checkout", "-q", "main"], { cwd: root3, encoding: "utf8" });
  const cand = await createCandidateWorktree(root3, taskId3, subId);
  execFileSync("git", ["merge", "--no-ff", ib, "-m", `candidate merge ${subId}`], { cwd: cand.worktreePath, encoding: "utf8" });
  const r = await promoteCandidateToIntegration(root3, taskId3, cand, integration3.worktreePath);
  assert(r.ok, `promote ${subId} ok`);
}
await approveSubtask("P3", "c.ts", "export const c = 3;");
await approveSubtask("P4", "d.ts", "export const d = 4;");
// integration содержит оба файла (последовательные ff).
const cContent = execFileSync("git", ["show", `${integrationBranch(taskId3)}:c.ts`], { cwd: root3, encoding: "utf8" }).trim();
const dContent = execFileSync("git", ["show", `${integrationBranch(taskId3)}:d.ts`], { cwd: root3, encoding: "utf8" }).trim();
assert(cContent === "export const c = 3;", "sequential promote: integration has c.ts (P3)");
assert(dContent === "export const d = 4;", "sequential promote: integration has d.ts (P4)");
await removeIntegrationWorktree(root3, integration3.worktreePath);

// cleanup temp repos
rmSync(root1, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
rmSync(root3, { recursive: true, force: true });
rmSync(regRoot, { recursive: true, force: true });

console.log("\nAll fan-out protocol checks passed.");
