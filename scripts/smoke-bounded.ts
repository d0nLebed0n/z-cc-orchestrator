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
