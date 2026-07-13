/**
 * Per-run метрики + JSON-отчёт (T2, upgrade-2026-07-13.md).
 *
 * На завершении задачи пишет `.orchestrator/results/<task>/report.json` со сводкой:
 * длительности шагов, число попыток (ретраев), ошибки, вердикты review, размер diff,
 * причины HITL-эскалаций, cache hits (T1). Источник данных — уже существующий
 * blackboard (state.json + sidecar results/ + log/*.jsonl) + git diff.
 *
 * Best-effort: ошибка сборки отчёта логируется, но не валит задачу (как archiveTask).
 */
import { readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BLACKBOARD_DIR,
  getTask,
  readResult,
  parseStepSegments,
  type TaskRecord,
  type StepRecord,
  type StepStatus,
  type TaskStatus,
  type LogEvent,
} from "./blackboard.ts";
import { atomicWrite } from "./lib/atomic-write.ts";

const execFileAsync = promisify(execFile);
const RESULTS_DIR = join(BLACKBOARD_DIR, "results");
const LOG_DIR = join(BLACKBOARD_DIR, "log");

/** Верdict review/final-шага, извлечённый из output. null если не найден. */
export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "ACCEPT" | null;

export interface StepReport {
  step_id: string;
  agent: string;
  role: string;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  /** finished_at − started_at в мс (включая commit/merge). null если timestamps нет. */
  duration_ms: number | null;
  /** Время самого воркера из sidecar (без commit/merge). null если sidecar'a нет. */
  worker_duration_ms: number | null;
  attempts: number;
  error: string | null;
  /** Для review/final: APPROVE/REJECT/... null для не-review шагов или если не распарсено. */
  verdict: Verdict;
  /** Номер итерации цикла (из stepId). null для не-цикловых шагов. */
  iteration: number | null;
  /** Id подзадачи fan-out (из stepId, напр. "P1"). null для не-fan-out шагов. */
  subtask: string | null;
}

export interface TaskReport {
  task_id: string;
  prompt: string;
  workflow: string;
  project: string;
  status: TaskStatus;
  success: boolean;
  /** min(step.started_at) → max(step.finished_at). null если шагов с таймстемпами нет. */
  started_at: string | null;
  finished_at: string | null;
  /** Сумма длительций шагов (wall time шагов, без параллелизма-перекрытий). null если нельзя посчитать. */
  total_duration_ms: number | null;
  steps: StepReport[];
  // ── агрегаты ──
  /** Сумма attempts по шагам (ретраи видны как attempts > 1). */
  total_attempts: number;
  /** step_id провалившихся шагов. */
  failed_steps: string[];
  /** kind log-событий, относящихся к эскалации/провалу (hitl_escalation, merge_conflict, ...). */
  escalated_reasons: string[];
  /** Файлы, изменённые задачей (передаёт runner из git diff --name-only). */
  diff_files: string[];
  diff_files_count: number;
  /** Вставлено/удалено строк (из git diff --numstat). undefined если не считалось. */
  diff_insertions: number | undefined;
  diff_deletions: number | undefined;
  /** Сколько шагов отработали из кэша (T1, logEvent kind="cache_hit"). */
  cache_hits: number;
  generated_at: string;
}

/**
 * Извлечь вердикт из текста output review/final-шага.
 * Формат зафиксирован в prompts/roles.ts: `VERDICT: APPROVE|REQUEST_CHANGES|REJECT|ACCEPT`.
 */
export function extractVerdict(output: string): Verdict {
  const m = output.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|REJECT|ACCEPT)\b/i);
  return m ? (m[1]!.toUpperCase() as NonNullable<Verdict>) : null;
}

/**
 * Собрать отчёт по задаче из blackboard + log + git.
 *
 * @param taskId   id задачи (T-XXXXXX)
 * @param root     blackboard root (где .orchestrator/ — state.json/results/log)
 * @param extra    данные, которые runner уже вычислил:
 *                 - changedFiles, baseSha, integrationBranch — git-данные
 *                 - gitRoot — целевой git-репозиторий (где integration-ветка).
 *                   review #10 (review-2026-07-13): для внешнего --project
 *                   integration-ветка в target repo, а не в blackboard root.
 *                   По умолчанию = root (один репозиторий).
 */
export async function generateReport(
  taskId: string,
  root: string = process.cwd(),
  extra: { changedFiles?: string[]; baseSha?: string | null; integrationBranch?: string; gitRoot?: string } = {},
): Promise<TaskReport> {
  const task = await getTask(taskId, root);
  if (!task) throw new Error(`generateReport: task ${taskId} not found in blackboard`);

  // Log events для этой задачи (для escalated_reasons + cache_hits).
  const events = await readTaskEvents(taskId, root);

  // Шаги: длительности, вердикты, итерации/подзадачи из sidecars + parseStepSegments.
  const stepReports: StepReport[] = [];
  for (const step of task.steps) {
    stepReports.push(await buildStepReport(taskId, step, root));
  }

  // Агрегаты.
  const totalAttempts = stepReports.reduce((sum, s) => sum + (s.attempts || 1), 0);
  const failedSteps = stepReports.filter((s) => s.status === "failed" || s.status === "escalated_hitl").map((s) => s.step_id);

  // Timing: min started_at → max finished_at по шагам.
  const starts = stepReports.map((s) => s.started_at).filter((t): t is string => !!t);
  const finishes = stepReports.map((s) => s.finished_at).filter((t): t is string => !!t);
  const startedAt = starts.sort()[0] ?? null;
  const finishedAt = finishes.sort().reverse()[0] ?? null;
  const totalDuration = computeTotalDuration(stepReports);

  // Diff: changedFiles из runner (уже вычислены). Для insertions/deletions — git --numstat.
  const changedFiles = extra.changedFiles ?? [];
  let diffInsertions: number | undefined;
  let diffDeletions: number | undefined;
  if (extra.baseSha && extra.integrationBranch) {
    // review #10 (review-2026-07-13): git diff — в target project (gitRoot),
    // не в blackboard root (для внешнего --project это разные репозитории).
    const stats = await computeDiffStats(extra.baseSha, extra.integrationBranch, extra.gitRoot ?? root).catch(() => null);
    if (stats) {
      diffInsertions = stats.insertions;
      diffDeletions = stats.deletions;
    }
  }

  // Escalated reasons: уникальные kind из log events (кроме info-level).
  const escalatedReasons = [...new Set(
    events
      .filter((e) => e.level === "warn" || e.level === "error")
      .map((e) => e.kind),
  )].sort();

  // Cache hits: сколько событий cache_hit для этой задачи (T1).
  const cacheHits = events.filter((e) => e.kind === "cache_hit").length;

  return {
    task_id: taskId,
    prompt: task.prompt,
    workflow: task.workflow,
    project: task.project,
    status: task.status,
    success: task.status === "done",
    started_at: startedAt,
    finished_at: finishedAt,
    total_duration_ms: totalDuration,
    steps: stepReports,
    total_attempts: totalAttempts,
    failed_steps: failedSteps,
    escalated_reasons: escalatedReasons,
    diff_files: changedFiles,
    diff_files_count: changedFiles.length,
    diff_insertions: diffInsertions,
    diff_deletions: diffDeletions,
    cache_hits: cacheHits,
    generated_at: new Date().toISOString(),
  };
}

/** Собрать StepReport из StepRecord + sidecar (для verdict, worker_duration_ms). */
async function buildStepReport(taskId: string, step: StepRecord, root: string): Promise<StepReport> {
  const seg = parseStepSegments(step.id);
  let verdict: Verdict = null;
  let workerDuration: number | null = null;
  // Sidecar может отсутствовать для провалившихся/оборванных шагов.
  try {
    const res = await readResult(taskId, step.id, root);
    if (res && typeof res === "object") {
      const r = res as { output?: string; duration_ms?: number };
      if (typeof r.output === "string") verdict = extractVerdict(r.output);
      if (typeof r.duration_ms === "number") workerDuration = r.duration_ms;
    }
  } catch {
    // битый/отсутствующий sidecar — не критично
  }
  return {
    step_id: step.id,
    agent: step.agent,
    role: step.role,
    status: step.status,
    started_at: step.started_at,
    finished_at: step.finished_at,
    duration_ms: durationMs(step.started_at, step.finished_at),
    worker_duration_ms: workerDuration,
    attempts: step.attempts,
    error: step.error,
    verdict,
    iteration: seg.iteration,
    subtask: seg.subtask,
  };
}

/** finished − started в мс, или null если хотя бы один timestamp отсутствует. */
function durationMs(started: string | null, finished: string | null): number | null {
  if (!started || !finished) return null;
  const ms = new Date(finished).getTime() - new Date(started).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Сумма длительностей шагов (без учёта параллелизма). null если ни у одного шага нет timing. */
function computeTotalDuration(steps: StepReport[]): number | null {
  let total = 0;
  let any = false;
  for (const s of steps) {
    if (s.duration_ms !== null) {
      total += s.duration_ms;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Прочитать ВСЕ log events для задачи из всех jsonl-файлов.
 * Log хранится по дням, задача может переходить через полночь — читаем все файлы.
 */
async function readTaskEvents(taskId: string, root: string): Promise<LogEvent[]> {
  const dir = join(root, LOG_DIR);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  const out: LogEvent[] = [];
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as LogEvent;
          if (ev.task_id === taskId) out.push(ev);
        } catch {
          // битая строка — пропускаем
        }
      }
    } catch {
      // не удалось прочитать файл — пропускаем
    }
  }
  return out;
}

/** Посчитать insertions/deletions через `git diff --numstat <base> <branch>`. */
async function computeDiffStats(
  baseSha: string,
  branch: string,
  root: string,
): Promise<{ insertions: number; deletions: number } | null> {
  let stdout: string;
  try {
    const res = await execFileAsync("git", ["diff", "--numstat", baseSha, branch], { cwd: root });
    stdout = res.stdout;
  } catch {
    return null;
  }
  // Формат: `<ins>\t<del>\t<path>` построчно. '-' для binary.
  let insertions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const ins = parts[0];
    const del = parts[1];
    if (ins && ins !== "-") insertions += Number.parseInt(ins, 10) || 0;
    if (del && del !== "-") deletions += Number.parseInt(del, 10) || 0;
  }
  return { insertions, deletions };
}

/** Путь к файлу отчёта: <root>/.orchestrator/results/<taskId>/report.json. */
export function reportPath(taskId: string, root: string = process.cwd()): string {
  return join(root, RESULTS_DIR, taskId, "report.json");
}

/** Записать отчёт атомарно. Возвращает путь к файлу. */
export async function writeReport(report: TaskReport, root: string = process.cwd()): Promise<string> {
  const path = reportPath(report.task_id, root);
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify(report, null, 2));
  return path;
}

/** Прочитать ранее записанный отчёт. null если отсутствует/повреждён. */
export async function readReport(taskId: string, root: string = process.cwd()): Promise<TaskReport | null> {
  const path = reportPath(taskId, root);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as TaskReport;
  } catch {
    return null;
  }
}

export type { TaskRecord, StepRecord };
