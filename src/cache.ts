/**
 * Content-addressable кэш ответов агентов (T1, upgrade-2026-07-13.md).
 *
 * Идея: если (agent, model, role, prompt) не менялись — ответ детерминирован, и
 * заново звать CLI-агента бессмысленно. Особенно полезно при итеративной отладке
 * воркфлоу и повторных fan-out'ах: plan/review/final не пересчитываются.
 *
 * Ключевая сложность: editing-роли (implement/refine/fix) пишут файлы в worktree,
 * а runner коммитит их ПОСЛЕ dispatchWorker. Поэтому кэш хранит не только
 * WorkerResult, но и git-patch правок; на hit patch replay'ится в свежий worktree
 * ДО штатного commitAllInWorktree → mergeWorktree. Для read-only ролей patch = null.
 *
 * Хранение: <root>/.orchestrator/cache/<hash>.json. Локальный (в .gitignore),
 * не шарится между машинами — приемлемо для локального инструмента.
 *
 * Все ошибки — best-effort: cache miss НИКОГДА не должен валить задачу.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskEnvelope } from "./envelope.ts";
import type { ModelInfo } from "./model-config-dto.ts";
import type { WorkerResult } from "./workers/types.ts";
import { BLACKBOARD_DIR } from "./blackboard.ts";
import { atomicWrite } from "./lib/atomic-write.ts";

const execFileAsync = promisify(execFile);
const CACHE_DIR = join(BLACKBOARD_DIR, "cache");

export interface CacheEntry {
  /** SHA-256 — он же имя файла. */
  hash: string;
  agent: string;
  role: string;
  /** Полный результат воркера (output, signals, reason, duration_ms, ...). */
  result: WorkerResult;
  /**
   * Полный diff правок worktree (включая untracked) после работы воркера
   * (для editing-ролей). null — у read-only ролей или если правок не было.
   * На hit replay'ится через `git apply` в свежий worktree.
   *
   * review #2 (T1-T5): снимается после `git add -A` во временном index'е,
   * чтобы включать новые/удалённые файлы (голый `git diff HEAD` их теряет).
   */
  patch: string | null;
  /**
   * SHA базового commit'а worktree на момент старта шага (для editing-ролей).
   * На hit проверяется: если HEAD worktree сместился — cache miss (patch
   * относится к другой версии кода). null для read-only ролей.
   * review #1 (T1-T5).
   */
  base_sha: string | null;
  /**
   * Fingerprint dirty-файлов worktree на момент старта шага (для editing-ролей):
   * `<sha> <porcelain status>`. Если состояние изменилось — cache miss.
   */
  dirty_fingerprint: string | null;
  /** ISO ts записи — для TTL. */
  created_at: string;
  /** model.model (тег) — для внешней инвалидации / отладки. */
  model_tag: string;
}

/**
 * Снять fingerprint репозитория для cache key: base SHA + digest dirty-содержимого.
 * Возвращает null, если cwd не git-репозиторий.
 *
 * review #5 (review-2026-07-13): digest включает НЕ только porcelain status
 * (он одинаков для двух разных правок того же файла), а содержимое diff +
 * untracked-файлов. Иначе разные изменения дают один ключ → stale cache.
 *
 * review #1 (T1-T5): без этого тот же prompt на изменившемся коде возвращает
 * устаревший plan/review или применяет patch от другой версии.
 */
export async function captureRepoFingerprint(cwd: string): Promise<{
  baseSha: string;
  dirtyFingerprint: string;
} | null> {
  try {
    const { stdout: sha } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"]);
    // Содержимое dirty: staged + unstaged diff (отслеживаемые) + untracked.
    // combine: porcelain (имена + состояния) + diff (содержимое правок) +
    // cat untracked-файлов. Сложим в один digest — достаточно для обнаружения
    // любого изменения рабочей копии.
    const { stdout: porcelain } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain"]);
    const { stdout: diff } = await execFileAsync("git", ["-C", cwd, "diff", "HEAD"]).catch(() => ({ stdout: "" }));

    // review #48 (review-2026-07-13): список untracked через NUL-separated
    // `git ls-files --others --exclude-standard -z`. Раньше брали из porcelain,
    // который (1) сворачивает новый каталог в `?? newdir/` — readFile давал
    // EISDIR, и любые изменения файлов внутри каталога имели один marker;
    // (2) квотит имена с пробелами как `?? "a b.txt"` — slice(3) оставлял кавычки,
    // readFile падал ENOENT, разные версии давали одинаковый marker.
    // ls-files -z разворачивает каталоги в отдельные файлы и не квотит.
    const { stdout: untrackedRaw } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"],
      { maxBuffer: 50 * 1024 * 1024 },
    ).catch(() => ({ stdout: "" }));
    // NUL-separated; последний элемент после финального NUL — пустой (отбрасываем).
    const untracked = untrackedRaw.split("\0").filter((f) => f.length > 0);

    // review #29: хешируем ПОЛНОЕ содержимое untracked без обрезки. Инкрементальный
    // hash — не копим всё в памяти. Ошибки чтения НЕ глотаем молча: пишем маркер
    // путь + код ошибки, иначе два разных сбоя (ENOENT, EACCES) и пустой файл
    // давали бы одинаковое состояние.
    const { readFile } = await import("node:fs/promises");
    const hash = createHash("sha256");
    hash.update(`base=${sha.trim()}\np=${porcelain}\ndiff=${diff}\nuntracked=`);
    for (const f of untracked) {
      hash.update(`\n${f}:\n`);
      try {
        const buf = await readFile(join(cwd, f));
        hash.update(buf);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "ERR";
        hash.update(`<unreadable:${code}>`);
      }
    }
    const dirtyFingerprint = hash.digest("hex").slice(0, 24);
    return { baseSha: sha.trim(), dirtyFingerprint };
  } catch {
    return null;
  }
}

/**
 * Детерминированный ключ кэша = SHA-256(agent + model + role + prompt + repo state).
 *
 * review #5 (review-2026-07-13): repo state включается для ВСЕХ ролей.
 * Раньше fingerprint игнорировался для plan/review/final — но эти агенты тоже
 * запускаются в worktree/integration-cwd и могут читать файлы, значит их ответ
 * зависит от HEAD/dirty. Тест, закреплявший неизменность ключа review при новом
 * commit, описывал неверное поведение.
 */
export function cacheKey(
  envelope: TaskEnvelope,
  model: ModelInfo,
  repoFingerprint?: { baseSha: string; dirtyFingerprint: string } | null,
): string {
  const keyMaterial = JSON.stringify({
    agent: envelope.agent,
    kind: model.kind,
    model: model.model ?? null,
    base_url: model.base_url ?? null,
    role: envelope.role,
    prompt: envelope.prompt,
    // review #5: repo state для ВСЕХ ролей (раньше только editing).
    repo: repoFingerprint
      ? { base: repoFingerprint.baseSha, dirty: repoFingerprint.dirtyFingerprint }
      : null,
  });
  return createHash("sha256").update(keyMaterial).digest("hex");
}

/** Путь к записи кэша: <root>/.orchestrator/cache/<hash>.json. */
export function cachePath(hash: string, root: string = process.cwd()): string {
  return join(root, CACHE_DIR, `${hash}.json`);
}

/**
 * Прочитать запись из кэша.
 * @returns запись или null (нет файла / истёк TTL / ошибка парсинга — всё это cache miss).
 */
export async function readCache(
  hash: string,
  opts: { ttlSec?: number; root?: string } = {},
): Promise<CacheEntry | null> {
  const path = cachePath(hash, opts.root);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let entry: CacheEntry;
  try {
    entry = JSON.parse(raw) as CacheEntry;
  } catch {
    // битый файл кэша — считаем miss'ом, не падаем
    return null;
  }
  // TTL: если запись старше ttlSec — считаем устаревшей.
  if (opts.ttlSec !== undefined && opts.ttlSec > 0) {
    const ageSec = (Date.now() - new Date(entry.created_at).getTime()) / 1000;
    if (ageSec > opts.ttlSec) return null;
  }
  return entry;
}

/**
 * Записать результат в кэш (атомарно). Ошибки подавлены — кэш не критичен.
 */
export async function writeCache(entry: CacheEntry, root: string = process.cwd()): Promise<void> {
  const path = cachePath(entry.hash, root);
  await atomicWrite(path, JSON.stringify(entry, null, 2));
}

/**
 * Применить git-patch в каталог worktree (replay правок editing-роли при cache hit).
 *
 * Записывает patch во временный файл (execFile не принимает stdin напрямую через
 * типы опций) и вызывает `git -C <cwd> apply`. Patch снimat как `<path>`-аргумент.
 *
 * Если задан `expectedBaseSha` — перед применением проверяет, что HEAD worktree
 * совпадает (patch относится к той же версии кода). При несовпадении — false
 * (cache miss). review #1 (T1-T5).
 *
 * @returns true если применён чисто; false при конфликте / ошибке / смещённом HEAD (caller фолбэчит на реального агента).
 *          Никогда не бросает — apply-ошибка = cache miss, не задача-падение.
 */
export async function applyPatch(
  patch: string,
  cwd: string,
  expectedBaseSha?: string | null,
): Promise<boolean> {
  if (!patch.trim()) return true; // пустой patch (read-only роль) — «применён» тривиально
  // Проверка base SHA: patch относится к конкретной версии кода.
  if (expectedBaseSha) {
    try {
      const { stdout: head } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"]);
      if (head.trim() !== expectedBaseSha) return false; // код сместился — cache miss
    } catch {
      return false; // не git-репо — patch применить нельзя корректно
    }
  }
  // Временный файл для patch (один patch — один файл; имя уникально).
  const patchFile = join(tmpdir(), `orch-cache-patch-${randomBytes(6).toString("hex")}.diff`);
  try {
    await writeFile(patchFile, patch, "utf8");
    await execFileAsync("git", ["-C", cwd, "apply", "--whitespace=nowarn", patchFile]);
    return true;
  } catch {
    // конфликт / грязный worktree / битый patch — cache miss
    return false;
  } finally {
    await unlink(patchFile).catch(() => {
      // best-effort cleanup
    });
  }
}
