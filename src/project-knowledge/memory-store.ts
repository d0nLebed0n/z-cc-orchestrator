/**
 * Персистентная память проекта: SQLite + FTS5 (T4, upgrade-2026-07-13.md).
 *
 * Хранит узлы Decision/Mistake/Pattern, извлечённые из результатов review/final
 * шагов. BM25-поиск (через FTS5) возвращает top-N релевантных фактов для инъекции
 * в system prompt plan-шага — агент «помнит» прошлые ошибки и решения проекта.
 *
 * Глобальная DB: ~/.orchestrator/knowledge.db (рядом с projects.json) —
 * соответствует централизованному паттерну registry. project_id = полный
 * SHA-256 от нормализованного abs path (slug basename-производный и нестабилен
 * при rename/move — для DB нужен стабильный идентификатор).
 *
 * Эмбеддинги НЕ входят (отдельный этап); keyword/BM25-поиск достаточно для
 * relative comparison фактов одного проекта.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";

const DEFAULT_DB_PATH = join(homedir(), ".orchestrator", "knowledge.db");

export type NodeType = "decision" | "mistake" | "pattern";

export interface MemoryNode {
  id?: number;
  /** Полный SHA-256 от нормализованного abs path проекта. */
  project_id: string;
  /** id задачи-источника (T-XXXXXX). */
  task_id: string;
  type: NodeType;
  /** Извлечённый текст (~500 char). */
  content: string;
  /** Ключевые слова для поиска (опц.). */
  keywords?: string;
  created_at: string;
}

/** Вход для addNode — без id/created_at (генерятся DB). */
export type MemoryNodeInput = Omit<MemoryNode, "id" | "created_at">;

/**
 * project_id = полный SHA-256 от нормализованного абсолютного пути.
 *
 * review Д1 (T1-T5): нормализация через resolve() + realpathSync.native()
 * (если путь существует). Иначе /repo, /repo/ и symlink давали разные хэши.
 */
export function projectIdFromPath(projectPath: string): string {
  const resolved = resolve(projectPath);
  let normalized = resolved;
  try {
    normalized = realpathSync.native(resolved);
  } catch {
    // путь не существует — используем resolved как есть
  }
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Инициализация DB (CREATE TABLE + FTS5 + triggers). Idempotent — безопасно
 * вызывать при каждом открытии. Возвращает открытое подключение.
 */
export function initMemoryDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('decision','mistake','pattern')),
      content TEXT NOT NULL,
      keywords TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_task ON nodes(task_id);

    -- FTS5 для BM25-поиска по content+keywords. External-content table —
    -- FTS индексирует nodes, сами данные живут в nodes.
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      content, keywords,
      content='nodes', content_rowid='id', tokenize='porter unicode61'
    );

    -- Триггеры синхронизации nodes → nodes_fts.
    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, content, keywords) VALUES (new.id, new.content, COALESCE(new.keywords, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, COALESCE(old.keywords, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, COALESCE(old.keywords, ''));
      INSERT INTO nodes_fts(rowid, content, keywords) VALUES (new.id, new.content, COALESCE(new.keywords, ''));
    END;
  `);

  // review #6 (review-2026-07-13): versioned migration. Старые базы (созданные
  // до unique index) могут содержать дубли (project_id, task_id, type, content) —
  // CREATE UNIQUE INDEX на такой базе падает. Поэтому сначала dedup в транзакции.
  const userVersion = db.pragma("user_version", { simple: true }) as number;
  if (userVersion < 1) {
    runMigrationV1(db);
    db.pragma("user_version = 1");
  }
  return db;
}

/**
 * Migration v1: идемпотентность memory (review #6 / New#3).
 * В транзакции: удалить дубли (оставив min(id) на группу), создать unique index.
 * Без этого CREATE UNIQUE INDEX падает на старой базе.
 */
function runMigrationV1(db: Database.Database): void {
  db.transaction(() => {
    // Удалить дубли: для каждой группы (project_id, task_id, type, content)
    // оставить только запись с минимальным id.
    db.exec(`
      DELETE FROM nodes WHERE id NOT IN (
        SELECT MIN(id) FROM nodes GROUP BY project_id, task_id, type, content
      );
    `);
    // review New#3 (T1-T5): unique index — идемпотентность retry/recovery.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_dedup ON nodes(project_id, task_id, type, content);
    `);
    // Удалить осиротевшие FTS-записи для удалённых nodes (на всякий случай).
    db.exec(`
      INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');
    `);
  })();
}

/**
 * Записать узел. Идемпотентно: дубль (тот же project_id+task_id+type+content)
 * игнорируется. Возвращает id записи (новой или существующей) и флаг `inserted`.
 *
 * review New#3 (T1-T5): без этого retry/recovery постепенно засоряет BM25
 * одинаковыми Decision/Mistake/Pattern.
 */
export function addNode(
  node: MemoryNodeInput,
  dbPath: string = DEFAULT_DB_PATH,
): { id: number; inserted: boolean } {
  const db = initMemoryDb(dbPath);
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO nodes (project_id, task_id, type, content, keywords, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      node.project_id,
      node.task_id,
      node.type,
      node.content,
      node.keywords ?? null,
      new Date().toISOString(),
    );
    const inserted = info.changes > 0;
    const id = inserted ? Number(info.lastInsertRowid) : findExistingId(db, node);
    return { id, inserted };
  } finally {
    db.close();
  }
}

/** Найти id существующего узла (при дедупликации INSERT OR IGNORE не вернул id). */
function findExistingId(db: Database.Database, node: MemoryNodeInput): number {
  const row = db
    .prepare(
      `SELECT id FROM nodes WHERE project_id=? AND task_id=? AND type=? AND content=? LIMIT 1`,
    )
    .get(node.project_id, node.task_id, node.type, node.content) as { id: number } | undefined;
  return row?.id ?? -1;
}

/**
 * Пакетная вставка узлов в одной транзакции одним соединением.
 * review #21 (review-2026-07-13): addNode открывал/закрывал DB + полный DDL на
 * каждый узел. В recordTaskMemory узлы вставляются в цикле — лишняя нагрузка.
 * Этот метод переиспользует одно соединение + transaction.
 *
 * @returns число реально новых узлов (inserted, дубли проигнорированы).
 */
export function addNodesBatch(
  nodes: MemoryNodeInput[],
  dbPath: string = DEFAULT_DB_PATH,
): number {
  if (nodes.length === 0) return 0;
  const db = initMemoryDb(dbPath);
  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO nodes (project_id, task_id, type, content, keywords, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    db.transaction(() => {
      for (const node of nodes) {
        const info = stmt.run(
          node.project_id,
          node.task_id,
          node.type,
          node.content,
          node.keywords ?? null,
          now,
        );
        if (info.changes > 0) inserted++;
      }
    })();
    return inserted;
  } finally {
    db.close();
  }
}

/**
 * BM25-поиск top-N узлов проекта по запросу (текст task prompt).
 * Возвращает узлы, отсортированные по релевантности (FTS5 bm25, ниже = лучше).
 */
export function searchNodes(
  projectId: string,
  query: string,
  limit = 5,
  dbPath: string = DEFAULT_DB_PATH,
): MemoryNode[] {
  const db = initMemoryDb(dbPath);
  try {
    // FTS5 bm25(): ниже = лучше релевантность, поэтому ORDER BY ASC.
    // Фильтрация по project_id — через JOIN (FTS не хранит project_id).
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const stmt = db.prepare(`
      SELECT n.id, n.project_id, n.task_id, n.type, n.content, n.keywords, n.created_at
      FROM nodes_fts f
      JOIN nodes n ON n.id = f.rowid
      WHERE n.project_id = ? AND nodes_fts MATCH ?
      ORDER BY bm25(nodes_fts) ASC
      LIMIT ?
    `);
    return stmt.all(projectId, ftsQuery, limit) as MemoryNode[];
  } catch {
    // FTS MATCH может бросить на синтаксисе запроса — возвращаем пусто (best-effort).
    return [];
  } finally {
    db.close();
  }
}

/** Все узлы проекта (для отладки/UI). Свежие первыми. */
export function listNodes(projectId: string, dbPath: string = DEFAULT_DB_PATH): MemoryNode[] {
  const db = initMemoryDb(dbPath);
  try {
    const stmt = db.prepare(
      `SELECT id, project_id, task_id, type, content, keywords, created_at FROM nodes WHERE project_id = ? ORDER BY created_at DESC`,
    );
    return stmt.all(projectId) as MemoryNode[];
  } finally {
    db.close();
  }
}

/**
 * Санировать поисковый запрос для FTS5 MATCH. FTS5 имеет свой синтаксис
 * ("AND"/"OR"/"NEAR", "*", quotes), и сырой текст task prompt'а может его
 * сломать. Разбиваем на слова, добавляем каждому префикс "*" (prefix search),
 * соединяем через OR — это прощает опечатки/неполные слова.
 */
function sanitizeFtsQuery(query: string): string {
  // review #6 (T1-T5): Unicode-классы \p{L}\p{N} — иначе кириллица/CJK режутся
  // и запрос из русского prompt становится пустым (searchNodes всегда []).
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 3)
    .slice(0, 20);
  if (words.length === 0) return "";
  // Префиксный поиск: "auth*" найдёт "auth", "authentication", "authorize".
  // Кавычки защищают от FTS-спецсимволов внутри слова.
  return words.map((w) => `"${w}"*`).join(" OR ");
}
