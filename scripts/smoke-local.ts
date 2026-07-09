/**
 * Local-executor smoke (Task 12).
 *
 * Validates the `decomposed` workflow shape offline:
 *  - loads + compiles via `loadWorkflow` (parses YAML, zod-validates, resolves)
 *  - asserts: 1 fanOut, fan_out agents include ollama, complexity_threshold 80
 *  - asserts the post-fan-out `final` step is correctly split out after fan-out
 *
 * NETWORK NOTE: the original brief pings the remote Ollama host (`checkHealth`).
 * That host is OFFLINE in this environment. To stay offline-safe, the network
 * probe is GATED behind the `SMOKE_NETWORK=1` env var and is skipped by default
 * (prints a DEFERRED line instead). It is NEVER reached unless explicitly opted in.
 *
 * Run:  npx tsx scripts/smoke-local.ts
 *       SMOKE_NETWORK=1 npx tsx scripts/smoke-local.ts   # opt-in network probe
 */
import { loadWorkflow } from "../src/runner.ts";
import { checkHealth } from "../src/workers/health.ts";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// ─── Step 1: load + compile the workflow (offline, no network) ─────────────
const wfPath = join(process.cwd(), "workflows/decomposed.yaml");
const wf = await loadWorkflow(wfPath);

// ─── Step 2: assert fan-out structure ──────────────────────────────────────
assert(wf.fanOuts.length === 1, "decomposed has 1 fan_out");
assert(wf.fanOuts[0]!.agents.includes("ollama"), "fan_out includes ollama");
assert(wf.fanOuts[0]!.agents.includes("glm"), "fan_out includes glm");
assert(wf.fanOuts[0]!.review === true, "fan_out review enabled (codex per subtask)");
assert(wf.fanOuts[0]!.fromPlanId === "plan", "fan_out reads plan from step 'plan'");
assert(wf.wf.complexity_threshold === 80, "complexity_threshold = 80");
assert(wf.wf.max_parallel === 3, "max_parallel = 3");

// fan_out step itself is excluded from preLevels (runner expands it later).
const preIds = wf.preLevels.flat().map((s) => s.id);
assert(preIds.includes("plan"), "plan runs in preLevels (before fan-out)");
assert(!preIds.includes("build"), "fan_out step excluded from preLevels");
// final depends on build → runs AFTER fan-out.
const postIds = wf.postFanOutLevels.flat().map((s) => s.id);
assert(postIds.includes("final"), "final runs after fan-out (postFanOutLevels)");

console.log("\nAll local-executor structural checks passed.");

// ─── Step 3: network check — DEFERRED by default (offline-safe) ────────────
// Gate: only reach the endpoint when SMOKE_NETWORK=1 is explicitly set.
// Otherwise the Ollama host (currently OFFLINE) would make the smoke fail.
const OLLAMA_URL = process.env.OLLAMA_BASE_URL;
if (process.env.SMOKE_NETWORK === "1") {
  if (!OLLAMA_URL) {
    console.error("✗ SMOKE_NETWORK=1 but OLLAMA_BASE_URL not set");
    process.exit(1);
  }
  console.log(`\nNetwork probe enabled (OLLAMA_BASE_URL=${OLLAMA_URL}). Checking ollama…`);
  const h = await checkHealth("ollama");
  const reachable = h.checks.find((c) => c.name === "reachable");
  if (!h.healthy) {
    console.error("✗ ollama not reachable:", h.reason ?? reachable?.detail ?? "unknown");
    process.exit(1);
  }
  console.log("✓ ollama reachable:", reachable?.detail);
} else {
  console.log(
    `\n⏸  Network check DEFERRED (offline-safe). Ollama host assumed offline. ` +
      `Set SMOKE_NETWORK=1 to probe OLLAMA_BASE_URL${OLLAMA_URL ? `=${OLLAMA_URL}` : " (not set)"}.`,
  );
}

console.log("\nDone.");
