/**
 * Атомарная запись файла: пишем во временный файл в той же директории,
 * затем переименовываем (rename атомарен на POSIX). Защищает от:
 *   - читателя, попавшего между truncate и завершением записи (невалидный JSON);
 *   - падения процесса в момент записи (остаётся предыдущий валидный файл).
 *
 * review #19 (review-2026-07-13): try/finally с unlink(tmp) — если rename
 * бросил (EXDEV/EACCES/ENOSPC), временный файл не остаётся сиротой.
 * review #20: явный chmod(tmp, mode) после writeFile — mode из writeFile
 * подвергается umask'у; chmod гарантирует точные биты (важно для .secrets 0600).
 */
import { writeFile, rename, unlink, chmod, mkdir } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Записать `data` в `filePath` атомарно.
 *
 * @param filePath  целевой файл
 * @param data      содержимое
 * @param options   mode — желаемые права файла (напр. 0o600 для секретов).
 *                  Директория-родитель создаётся при необходимости.
 */
export async function atomicWrite(
  filePath: string,
  data: string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  // Временный файл в той же директории (чтобы rename был атомарным — гарантия
  // только внутри одной ФС; /tmp на отдельной ФС отнял бы атомарность).
  const tmp = join(dir, `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data);
    // review #20: chmod после writeFile — не подвержен umask.
    if (options.mode !== undefined) {
      await chmod(tmp, options.mode);
    }
    await rename(tmp, filePath);
  } catch (e) {
    // review #19: почистить временный файл при сбое rename.
    await unlink(tmp).catch(() => {
      // ignore — файла уже может не быть
    });
    throw e;
  }
}
