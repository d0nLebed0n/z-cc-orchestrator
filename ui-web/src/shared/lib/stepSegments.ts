import type { StepRecord } from "@/entities";

/**
 * Frontend-порт parseStepSegments из src/blackboard.ts (U5, upgrade-2026-07-13.md).
 * Разбирает stepId вида <base>[#<iteration>][~<subtask>[r]] на сегменты.
 * Портирован 1:1 — без backend-зависимостей.
 */
export interface StepSegments {
  base: string;
  iteration: number | null; // из "#N" (итерации цикла)
  subtask: string | null; // из "~<id>" (fan-out подзадача)
  isReview: boolean; // trailing "r" после subtask
}

export function parseStepSegments(stepId: string): StepSegments {
  const tildeIdx = stepId.indexOf("~");
  const hashIdx = stepId.indexOf("#");
  const base = stepId.slice(
    0,
    Math.min(tildeIdx === -1 ? stepId.length : tildeIdx, hashIdx === -1 ? stepId.length : hashIdx),
  );
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
    if (after.endsWith("r")) {
      isReview = true;
      after = after.slice(0, -1);
    }
    subtask = after || null;
  }
  return { base, iteration, subtask, isReview };
}

/**
 * Группа шагов для степпера (U5). Шаги группируются по структуре:
 *  - fan-out подзадачи (base = X, subtask = "P1") — в одну группу под родителем
 *  - итерации цикла (base = X, iteration = N) — в группу «Круг N»
 *  - обычные линейные шаги — каждый самостоятельной группой.
 *
 * Группы сохраняют порядок шагов из task.steps.
 */
export interface StepGroup {
  /** Ключ группировки — человекочитаемая метка (base, либо "Круг N", либо "fan-out: P1/P2/..."). */
  key: string;
  /** Метка для UI. */
  label: string;
  /** Шаги в группе. */
  steps: StepRecord[];
  /** Тип группы — для иконки/стиля. */
  kind: "linear" | "loop" | "fanout";
}

/**
 * Сгруппировать шаги задачи для степпера.
 * Стратегия:
 *  - Шаги с subtask и одним base → одна группа fan-out (метка = "fan-out: P1, P2, ...").
 *  - Шаги с iteration и одним base → группы "Круг N" (по одной на iteration).
 *  - Остальные — individual linear-группы.
 */
export function groupSteps(steps: StepRecord[]): StepGroup[] {
  // Сегменты каждого шага.
  const segs = steps.map((s) => ({ step: s, seg: parseStepSegments(s.id) }));

  // Подзадачи fan-out: все с subtask !== null и одним base.
  const fanoutBase = segs.find((x) => x.seg.subtask !== null)?.seg.base ?? null;
  // Шаги с итерациями (цикл).
  const loopStep = segs.find((x) => x.seg.iteration !== null && x.seg.subtask === null);

  const groups: StepGroup[] = [];
  let i = 0;
  while (i < segs.length) {
    const { step, seg } = segs[i]!;

    // fan-out подзадачи — собрать все шаги с этим base и subtask.
    if (seg.subtask !== null && seg.base === fanoutBase) {
      const fanoutSteps = segs
        .filter((x) => x.seg.base === fanoutBase && x.seg.subtask !== null)
        .map((x) => x.step);
      const subtaskIds = Array.from(
        new Set(fanoutSteps.map((s) => parseStepSegments(s.id).subtask!)),
      ).sort();
      groups.push({
        key: `fanout-${fanoutBase}`,
        label: `fan-out: ${subtaskIds.join(", ")}`,
        steps: fanoutSteps,
        kind: "fanout",
      });
      // Перепрыгнуть все fan-out шаги (они могут идти не подряд — но логически группа).
      i = segs.length;
      // Если остались шаги после fan-out (напр. final) — добавим их ниже.
      for (let j = 0; j < segs.length; j++) {
        const sj = segs[j]!;
        if (sj.seg.base !== fanoutBase || sj.seg.subtask === null) {
          if (sj.seg.iteration !== null) continue; // циклы обработаны отдельно
          groups.push({
            key: `linear-${sj.step.id}`,
            label: `${sj.step.agent}(${sj.step.role})`,
            steps: [sj.step],
            kind: "linear",
          });
        }
      }
      break;
    }

    // Цикл: шаги с одним base и разными iteration → группы «Круг N».
    if (seg.iteration !== null && seg.subtask === null && loopStep) {
      const loopBase = loopStep.seg.base;
      // Собрать все итерации для этого base, сгруппировать по iteration.
      const byIter = new Map<number, StepRecord[]>();
      for (const x of segs) {
        if (x.seg.base === loopBase && x.seg.iteration !== null && x.seg.subtask === null) {
          const arr = byIter.get(x.seg.iteration) ?? [];
          arr.push(x.step);
          byIter.set(x.seg.iteration, arr);
        }
      }
      const iters = [...byIter.keys()].sort((a, b) => a - b);
      for (const it of iters) {
        groups.push({
          key: `loop-${loopBase}-${it}`,
          label: `Круг ${it}`,
          steps: byIter.get(it)!,
          kind: "loop",
        });
      }
      // Перепрыгнуть остальные цикловые шаги.
      while (i < segs.length && segs[i]!.seg.base === loopBase && segs[i]!.seg.iteration !== null) {
        i++;
      }
      continue;
    }

    // Обычный линейный шаг.
    groups.push({
      key: `linear-${step.id}`,
      label: `${step.agent}(${step.role})`,
      steps: [step],
      kind: "linear",
    });
    i++;
  }

  return groups;
}

/** Итоговый статус группы шагов: success если все success, failed если хоть один failed/escalated, иначе running. */
export type GroupStatus = "success" | "running" | "failed" | "pending";

export function groupStatus(steps: StepRecord[]): GroupStatus {
  if (steps.some((s) => s.status === "failed" || s.status === "escalated_hitl")) return "failed";
  if (steps.some((s) => s.status === "running")) return "running";
  if (steps.some((s) => s.status === "pending")) return "pending";
  return "success";
}
