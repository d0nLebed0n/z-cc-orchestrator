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

// duplicate subtask ids → reject (candidate branch collision guard)
try {
  parsePlan('{"subtasks":[{"id":"P1","title":"t","goal":"g","complexity":10,"target_paths":["a.ts"],"acceptance_criteria":"ok"},{"id":"P1","title":"t2","goal":"g2","complexity":20,"target_paths":["b.ts"],"acceptance_criteria":"ok2"}]}');
  console.error("✗ duplicate subtask ids should throw"); process.exit(1);
}
catch { console.log("✓ duplicate subtask ids rejected"); }

console.log("\nAll plan checks passed.");
