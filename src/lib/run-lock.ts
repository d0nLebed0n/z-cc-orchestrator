/**
 * Межпроцессный global run lock (review #7, review-2026-07-13).
 *
 * async-mutex в blackboard.ts работает только внутри одного процесса.
 * CLI-run — отдельный процесс, backend/MCP/ручной CLI — независимые поверхности.
 * Два запуска могли одновременно read-modify-write одного state.json → потеря
 * TaskRecord/StepRecord. Этот lockfile — единая точка для всех.
 *
 * Стратегия: lockfile `.orchestrator/.run-lock` в blackboard root, содержит
 * owner-token (PID + уникальный nonce на захват). stale-detection: если процесс
 * с этим PID не существует → lock захвачен (произошёл crash). Не lease-based —
 * достаточно для локального однопользовательского инструмента.
 *
 * review #25 (review-2026-07-13):
 *   - родительский каталог создаётся перед захватом (иначе ENOENT на чистом root);
 *   - атомарный захват через `open(..., "wx")` (O_EXCL) — нет TOCTOU;
 *   - owner-token: release удаляет файл только если текущий владелец совпадает
 *     (защита от удаления чужого lock'а после stale-recovery);
 *   - битый/stale lock удаляется и попытка повторяется безопасно.
 */
import { open, unlink, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { BLACKBOARD_DIR } from "../blackboard.ts";

const LOCK_FILE = join(BLACKBOARD_DIR, ".run-lock");

export interface RunLock {
  /** Уникальный токен владельца для этого захвата. */
  readonly ownerToken: string;
  release(): void;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 — проверка существования
    return true;
  } catch {
    return false; // ESRCH — процесса нет
  }
}

/**
 * Прочитать lock-файл и вернуть { pid, token } либо null (битый/пустой).
 * Формат: строка `pid:nonce` (напр. `4221:a3f9...`).
 */
async function readLock(path: string): Promise<{ pid: number; token: string } | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    const sep = raw.lastIndexOf(":");
    if (sep <= 0) return null;
    const pid = Number.parseInt(raw.slice(0, sep), 10);
    const token = raw.slice(sep + 1);
    if (!Number.isFinite(pid) || !token) return null;
    return { pid, token };
  } catch {
    return null;
  }
}

/**
 * Атомарно создать lock-файл с нашим owner-token. Возвращает true при успехе,
 * false если файл уже существует (EEXIST).
 */
async function tryCreateLock(path: string, ownerToken: string): Promise<boolean> {
  const pid = process.pid;
  try {
    const fh = await open(path, "wx", 0o644);
    await fh.writeFile(`${pid}:${ownerToken}`);
    await fh.close();
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Захватить global run lock. Бросает Error, если уже занят живым процессом.
 * Stale-lock (от crash'нувшего процесса) удаляется автоматически.
 *
 * @param root blackboard root (где .orchestrator/)
 */
export async function acquireRunLock(root: string = process.cwd()): Promise<RunLock> {
  const lockPath = join(root, LOCK_FILE);
  // review #25: создаём родительский каталог — на чистом root .orchestrator/ нет.
  await mkdir(dirname(lockPath), { recursive: true });
  const ownerToken = randomBytes(8).toString("hex");

  // Первая попытка — обычно каталог свежий или lock свободен.
  if (await tryCreateLock(lockPath, ownerToken)) {
    return makeLock(lockPath, ownerToken);
  }

  // Файл существует — разбираемся, жив ли владелец.
  const existing = await readLock(lockPath);
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(
      `another orchestrator run is active (pid ${existing.pid}). Wait for it or remove ${lockPath} if stale.`,
    );
  }

  // Stale (владелец мёртв) или битый lock — удаляем и повторяем.
  // Используем existsSync + unlink (не atomic, но владелец подтверждённо мёртв;
  // гонка теоретически возможна, если второй процесс только что завладел —
  // тогда наш unlink удалит чужой lock. Чтобы этого избежать, после unlink
  // делаем tryCreateLock и при неудаче перечитываем владельца: если живой —
  // отступаем, иначе считаем lock снова stale и берём ещё раз.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (existsSync(lockPath)) {
      // перепроверяем владельца прямо перед удалением — мог смениться.
      const cur = await readLock(lockPath);
      if (cur && isProcessAlive(cur.pid) && cur.token !== ownerToken) {
        throw new Error(
          `another orchestrator run is active (pid ${cur.pid}). Wait for it or remove ${lockPath} if stale.`,
        );
      }
      try {
        await unlink(lockPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw e; // кто-то уже удалил — нормально
      }
    }
    if (await tryCreateLock(lockPath, ownerToken)) {
      return makeLock(lockPath, ownerToken);
    }
  }

  throw new Error(
    `failed to acquire run lock ${lockPath} after retries (concurrent acquire?). Remove it manually if stale.`,
  );
}

function makeLock(lockPath: string, ownerToken: string): RunLock {
  return {
    ownerToken,
    /**
     * Освободить lock: удалить файл ТОЛЬКО если мы всё ещё владеем им.
     * review #25: иначе release после stale-recovery мог удалить чужой lock.
     */
    release(): void {
      (async () => {
        const cur = await readLock(lockPath);
        // Удаляем только если владелец — мы. Нет файла / другой владелец — не трогаем.
        if (cur && cur.token === ownerToken) {
          try {
            await unlink(lockPath);
          } catch {
            // ignore — файл уже удалён
          }
        }
      })().catch(() => {
        // best-effort: ошибка чтения/удаления не должна валить release.
      });
    },
  };
}
