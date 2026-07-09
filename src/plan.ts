/**
 * План декомпозиции из шага plan (claude): JSON, валидируется zod.
 * agent НЕ задаётся в плане — он выводится раннером по complexity vs threshold.
 */
import { z } from "zod";

export const SubtaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  complexity: z.number().int().min(0).max(100),
  target_paths: z.array(z.string().min(1)).default([]),
  acceptance_criteria: z.string().min(1),
});
export type Subtask = z.infer<typeof SubtaskSchema>;

export const SubtaskPlanSchema = z.object({
  subtasks: z.array(SubtaskSchema).min(1),
});
export type SubtaskPlan = z.infer<typeof SubtaskPlanSchema>;

/**
 * Достать JSON-план из вывода plan-шага. Поддерживает:
 *  - fenced ```json ... ```
 *  - голый {...} объект
 * Бросает при отсутствии/невалидности JSON или провале zod-схемы.
 */
export function parsePlan(output: string): SubtaskPlan {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("parsePlan: empty output");

  // 1. fenced ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]!.trim());

  // 2. первый {...} блок в исходном тексте
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }

  let parsed: unknown = null;
  let lastErr: unknown = null;
  for (const c of candidates) {
    try { parsed = JSON.parse(c); break; }
    catch (e) { lastErr = e; }
  }
  if (parsed === null) {
    throw new Error(`parsePlan: no valid JSON found in plan output${lastErr ? ` (${lastErr instanceof Error ? lastErr.message : lastErr})` : ""}`);
  }
  return SubtaskPlanSchema.parse(parsed);
}
