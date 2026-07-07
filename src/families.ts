/**
 * Семьи моделей и правила кросс-семейного ревью (PLAN §1, §3.4).
 *
 * Три семьи: Anthropic (Claude), OpenAI (Codex), Z.ai (GLM).
 * GLM запускается бинарником `claude`, но считается отдельной семьёй Z.ai —
 * для правил ревью он чужой по отношению к Anthropic-Claude.
 */

export type Family = "anthropic" | "openai" | "zai";
export type AgentName = "claude" | "codex" | "glm";

export interface AgentInfo {
  name: AgentName;
  family: Family;
  /** Каким бинарником запускается (справочно, реальный путь — в workers/). */
  binary: "claude" | "codex";
}

export const AGENTS: Record<AgentName, AgentInfo> = {
  claude: { name: "claude", family: "anthropic", binary: "claude" },
  codex: { name: "codex", family: "openai", binary: "codex" },
  glm: { name: "glm", family: "zai", binary: "claude" },
};

/** Все семьи, отличные от данной — валидные ревьюеры. */
export function validReviewerFamilies(author: Family): Family[] {
  const all: Family[] = ["anthropic", "openai", "zai"];
  return all.filter((f) => f !== author);
}

/**
 * Выбрать агента-ревьюера из семьи, отличной от автора кода.
 * @param authorFamily семья автора кода (кто писал на шаге implement)
 * @param prefer предпочтительный агент, если он подходит по семье
 * @returns агент-ревьюер из чужой семьи
 * @throws если предпочтённый агент той же семьи (это ошибка валидации воркфлоу)
 */
export function pickReviewer(
  authorFamily: Family,
  prefer?: AgentName,
): AgentName {
  if (prefer) {
    const preferFamily = AGENTS[prefer].family;
    if (preferFamily === authorFamily) {
      throw new CrossFamilyViolation(
        `Reviewer '${prefer}' (${preferFamily}) same family as author (${authorFamily}). ` +
          `Set allow_same_family: true on the step or pick a different reviewer.`,
      );
    }
    return prefer;
  }
  // Дефолтный выбор: первый подходящий из [claude, codex, glm].
  const valid = validReviewerFamilies(authorFamily);
  const candidate: AgentName =
    valid.find((f) => f === "anthropic") === "anthropic"
      ? "claude"
      : valid.find((f) => f === "openai") === "openai"
        ? "codex"
        : "glm";
  return candidate;
}

export class CrossFamilyViolation extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CrossFamilyViolation";
  }
}
