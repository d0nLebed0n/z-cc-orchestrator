/**
 * Семьи моделей и правила кросс-семейного ревью (PLAN §1, §3.4).
 *
 * Семьи фиксированы (anthropic/openai/zai/local) — это семантическое понятие
 * для cross-family review. Каталог конкретных моделей — в model-registry.
 *
 * `Family` переэкспортируется из model-config-dto (Task 2) для обратной
 * совместимости: остальные модули импортируют его отсюда.
 */
import { getModels, getModel } from "./model-registry.ts";
import type { Family } from "./model-config-dto.ts";

export type { Family };

/** Все семьи, отличные от данной и способные ревьюить. local — implement-only. */
const REVIEWER_FAMILIES: Family[] = ["anthropic", "openai", "zai"];

export function validReviewerFamilies(author: Family): Family[] {
  return REVIEWER_FAMILIES.filter((f) => f !== author);
}

/** Семья модели по id (из реестра). */
export function getAgentFamily(id: string): Family | undefined {
  return getModel(id)?.family;
}

/**
 * Выбрать модель-ревьюера из семьи, отличной от автора кода.
 * @param authorFamily семья автора кода
 * @param prefer предпочтительный id модели (опционально)
 * @returns id модели-ревьюера из чужой семьи
 */
export function pickReviewer(authorFamily: Family, prefer?: string): string {
  if (prefer) {
    const preferFamily = getModel(prefer)?.family;
    if (!preferFamily) {
      throw new CrossFamilyViolation(`pickReviewer: model '${prefer}' not found in registry`);
    }
    if (preferFamily === authorFamily) {
      throw new CrossFamilyViolation(
        `Reviewer '${prefer}' (${preferFamily}) same family as author (${authorFamily}). ` +
          `Set allow_same_family: true on the step or pick a different reviewer.`,
      );
    }
    return prefer;
  }
  const valid = validReviewerFamilies(authorFamily);
  // Берём первую модель подходящей семьи из реестра (порядок как в models.yaml).
  for (const fam of valid) {
    const m = getModels().find((x) => x.family === fam);
    if (m) return m.id;
  }
  // review #62 (review-2026-07-13): нет модели чужой семьи. Раньше фолбэк брал
  // любую не-local модель — включая семью автора, молча нарушая кросс-семейный
  // инвариант PLAN §3.4. Теперь бросаем ошибку: тихой подмены быть не должно.
  throw new CrossFamilyViolation(
    `No reviewer model available in a family other than '${authorFamily}'. ` +
      `Add a model from a different family in Settings or set allow_same_family on the step.`,
  );
}

export class CrossFamilyViolation extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CrossFamilyViolation";
  }
}
