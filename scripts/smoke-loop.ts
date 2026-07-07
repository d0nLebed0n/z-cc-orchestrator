/**
 * Smoke: проверка логики цикла — парсер вердикта (regex) + newStepId.
 * Запуск: npx tsx scripts/smoke-loop.ts
 */
import { newStepId } from "../src/blackboard.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("✗ " + msg);
    process.exit(1);
  }
  console.log("✓ " + msg);
}

async function main(): Promise<void> {
  // Тот же regex, что в runner.ts parseVerdict.
  const re = /VERDICT:\s*(APPROVE|REQUEST_CHANGES|REJECT|ACCEPT)\b/i;
  const cases: { verdict: string; expected: string }[] = [
    { verdict: "## Review\nVERDICT: APPROVE\n### Blockers\n- None", expected: "APPROVE" },
    { verdict: "VERDICT: REQUEST_CHANGES\n### Blockers\n- [x.ts:1] bug", expected: "REQUEST_CHANGES" },
    { verdict: "VERDICT: REJECT\nthis is wrong", expected: "REJECT" },
    { verdict: "## Final\nVERDICT: ACCEPT\nTests: pass", expected: "ACCEPT" },
    { verdict: "no verdict here, just rambling", expected: "null" },
  ];

  for (const c of cases) {
    const m = c.verdict.match(re);
    const got = m ? m[1]!.toUpperCase() : "null";
    assert(got === c.expected, `verdict parse: '${c.verdict.slice(0, 30)}...' → ${got} (expected ${c.expected})`);
  }

  // newStepId с итерацией.
  assert(newStepId("T-001", 3, 1) === "T-001-S03", "stepId iter 1 = T-001-S03 (no suffix)");
  assert(newStepId("T-001", 3, 2) === "T-001-S03#2", "stepId iter 2 = T-001-S03#2");
  assert(newStepId("T-001", 3, 3) === "T-001-S03#3", "stepId iter 3 = T-001-S03#3");

  const id1 = newStepId("T-002", 3, 1);
  const id2 = newStepId("T-002", 3, 2);
  assert(id1 !== id2, `iteration stepIds differ: ${id1} vs ${id2}`);

  console.log("\nAll loop smoke checks passed.");
}

main();

