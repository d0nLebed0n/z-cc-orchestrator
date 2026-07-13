/**
 * Извлечение узлов памяти (Decision/Mistake/Pattern) из результатов review/final
 * шагов (T4, upgrade-2026-07-13.md).
 *
 * Эвристики (без LLM) — детерминированные regex/слайсы по output. Достаточно
 * для BM25-поиска; LLM-извлечение — отдельный опциональный этап.
 *
 * Источник: output field из results/<taskId>-<stepId>.json (sidecar blackboard'а).
 * Формат review: "## Review\nVERDICT: ...\n### Blockers\n...\n### Suggestions\n..."
 * Формат final: "## Final\nVERDICT: ACCEPT|REJECT\n...\nNotes: ..."
 */
import { extractVerdict } from "../report.ts";
import { getTask, readResult } from "../blackboard.ts";
import {
  addNodesBatch,
  projectIdFromPath,
  type MemoryNodeInput,
  type NodeType,
} from "./memory-store.ts";

const MAX_CONTENT = 500;

type Verdict = ReturnType<typeof extractVerdict>;

/** Контекст extraction'а — что нужно знать о задаче для записи узла. */
interface ExtractCtx {
  taskId: string;
  prompt: string;
}

/**
 * Извлечь узлы из output review-шага по вердикту.
 *   REJECT / REQUEST_CHANGES → Mistake (текст Blockers).
 *   APPROVE → Decision (prompt + "approved approach").
 */
export function extractFromReview(
  output: string,
  verdict: Verdict,
  ctx: ExtractCtx,
): MemoryNodeInput[] {
  const nodes: MemoryNodeInput[] = [];
  const projectId = ""; // задаётся в recordTaskMemory; здесь без project_id
  if (verdict === "REJECT" || verdict === "REQUEST_CHANGES") {
    const blockers = sliceSection(output, "### Blockers", "###");
    if (blockers) {
      nodes.push({
        project_id: projectId, task_id: ctx.taskId, type: "mistake",
        content: truncate(`Review rejected: ${blockers.trim()}`, MAX_CONTENT),
        keywords: extractKeywords(ctx.prompt + " " + blockers),
      });
    }
  } else if (verdict === "APPROVE") {
    nodes.push({
      project_id: projectId, task_id: ctx.taskId, type: "decision",
      content: truncate(`Approved approach for: ${ctx.prompt}`, MAX_CONTENT),
      keywords: extractKeywords(ctx.prompt),
    });
  }
  return nodes;
}

/**
 * Извлечь узлы из output final-шага по вердикту.
 *   ACCEPT → Decision (задача завершена успешно).
 *   Notes: непустой → Pattern (каверзы/оговорки).
 */
export function extractFromFinal(
  output: string,
  verdict: Verdict,
  ctx: ExtractCtx,
): MemoryNodeInput[] {
  const nodes: MemoryNodeInput[] = [];
  const projectId = "";
  if (verdict === "ACCEPT") {
    nodes.push({
      project_id: projectId, task_id: ctx.taskId, type: "decision",
      content: truncate(`Task completed successfully: ${ctx.prompt}`, MAX_CONTENT),
      keywords: extractKeywords(ctx.prompt),
    });
  }
  // Notes — всегда Pattern, независимо от вердикта (оговарки полезны).
  const notes = sliceAfter(output, "Notes:");
  const notesTrim = notes?.trim();
  if (notesTrim && notesTrim.toLowerCase() !== "none" && !notesTrim.toLowerCase().startsWith("n/a")) {
    nodes.push({
      project_id: projectId, task_id: ctx.taskId, type: "pattern",
      content: truncate(`Caveat from final review: ${notesTrim}`, MAX_CONTENT),
      keywords: extractKeywords(ctx.prompt + " " + notesTrim),
    });
  }
  return nodes;
}

/**
 * Записать узлы памяти задачи: прочитать все review/final шаги из blackboard,
 * извлечь узлы эвристиками, сохранить в DB. Возвращает кол-во записанных узлов.
 *
 * @param dbPath опциональный путь к DB (для тестов). По умолчанию ~/.orchestrator/knowledge.db.
 */
export async function recordTaskMemory(
  taskId: string,
  projectPath: string,
  root?: string,
  dbPath?: string,
): Promise<number> {
  const task = await getTask(taskId, root);
  if (!task) return 0;
  const projectId = projectIdFromPath(projectPath);
  // review #21 (review-2026-07-13): накапливаем узлы и batch-insert одним
  // соединением + transaction (а не open/close DB на каждый узел).
  const allNodes: MemoryNodeInput[] = [];
  for (const step of task.steps) {
    if (step.role !== "review" && step.role !== "final") continue;
    const res = await readResult(taskId, step.id, root);
    if (!res || typeof res !== "object" || !("output" in res)) continue;
    const output = String((res as { output: string }).output);
    const verdict = extractVerdict(output);
    const ctx: ExtractCtx = { taskId, prompt: task.prompt };
    const extractor = step.role === "review" ? extractFromReview : extractFromFinal;
    const nodes = extractor(output, verdict, ctx);
    // Подставить реальный project_id (extractor'ы оставляют пустым).
    allNodes.push(...nodes.map((n) => ({ ...n, project_id: projectId })));
  }
  if (allNodes.length === 0) return 0;
  // review New#3 (T1-T5): batch возвращает только реально новые (inserted).
  return addNodesBatch(allNodes, dbPath);
}

// ─── Хелперы эвристик ─────────────────────────────────────────────────────────

/**
 * Вырезать секцию между `startMarker` и следующим `nextMarker`/EOF.
 * Напр. sliceSection(output, "### Blockers", "###") → текст Blockers до Suggestions.
 */
function sliceSection(text: string, startMarker: string, nextMarker: string): string | null {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const afterStart = startIdx + startMarker.length;
  const nextIdx = text.indexOf(nextMarker, afterStart);
  const end = nextIdx === -1 ? text.length : nextIdx;
  return text.slice(afterStart, end);
}

/** Вырезать текст после маркера до конца (напр. "Notes: ..."). */
function sliceAfter(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  return text.slice(idx + marker.length);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * Извлечь ключевые слова из текста для поиска. Простая эвристика: слова длиной
 * 4+, lowercased, уникальные, до 15 штук. Не стемминг — FTS5 porter-токенайзер
 * сделает стемминг при поиске.
 */
function extractKeywords(text: string): string {
  // review #6 (T1-T5): Unicode-классы — иначе кириллица/CJK теряется.
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 4)
    .filter((w, i, arr) => arr.indexOf(w) === i) // уникальные
    .slice(0, 15);
  return words.join(" ");
}

export type { NodeType };
