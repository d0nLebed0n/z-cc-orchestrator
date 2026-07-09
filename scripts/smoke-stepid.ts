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
