import { Injectable, Logger } from "@nestjs/common";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config";
import type { BlackboardState, TaskRecord } from "./types";

/**
 * Сигнальная ошибка: state.json не распарсился (рваное чтение при
 * кросс-процессной гонке или реальная порча). readState перехватывает её и
 * отдаёт предыдущий валидный кеш вместо пустого списка (review #43).
 */
class StateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateParseError";
  }
}

/**
 * Чтение .orchestrator/state.json как внешнего файла.
 * Не зависит от кода раннера. Кеш на 1 c — state.json переписывается
 * целиком на каждом шаге, частые перечитывания избыточны.
 */
@Injectable()
export class BlackboardReader {
  private readonly logger = new Logger(BlackboardReader.name);
  private cache: { at: number; state: BlackboardState } | null = null;
  private readonly ttlMs = 1000;

  async readState(): Promise<BlackboardState> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) {
      return this.cache.state;
    }
    try {
      const state = await this.readStateFromDisk();
      // review #43: кешируем только валидное состояние с диска.
      this.cache = { at: now, state };
      return state;
    } catch (e) {
      if (e instanceof StateParseError) {
        // Повреждённый/рваный state — отдаём предыдущий валидный кеш, не
        // подменяя пустым списком и не обновляя кеш. Лог уже записан в readStateFromDisk.
        if (this.cache) return this.cache.state;
        // Кеша ещё нет (первое чтение оказалось рваным) — честно пусто,
        // но НЕ кешируем пустышку, чтобы следующий запрос перечитал диск.
        return { tasks: [] };
      }
      throw e;
    }
  }

  /** Принудительно сбросить кеш (после запуска/остановки задачи). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Прочитать state с диска.
   *
   * review #43 (review-2026-07-13): при ошибке парсинга НЕ подменяем пустым
   * списком (это переоткрывает класс бага, закрытый на write-side #3 —
   * потеря активного стрима/accept при рваном чтении). Бросаем StateParseError;
   * readState перехватывает и отдаёт предыдущий валидный кеш.
   * Корректный пустой случай (файла нет / tasks не массив) возвращает {tasks:[]}.
   */
  private async readStateFromDisk(): Promise<BlackboardState> {
    if (!existsSync(PATHS.stateFile)) {
      return { tasks: [] };
    }
    let raw: string;
    try {
      raw = await readFile(PATHS.stateFile, "utf8");
    } catch (e) {
      // Ошибка чтения файла (отличная от ENOENT — он обработан выше) — не
      // подменяем пустым. Бросаем, readState отдаст кеш.
      throw new StateParseError(`Failed to read state.json: ${(e as Error).message}`);
    }
    let parsed: BlackboardState;
    try {
      parsed = JSON.parse(raw) as BlackboardState;
    } catch (e) {
      this.logger.error(`Corrupt state.json (unparseable): ${(e as Error).message}`);
      throw new StateParseError(`Corrupt state.json: ${(e as Error).message}`);
    }
    if (!parsed || !Array.isArray(parsed.tasks)) {
      // Структурно невалидный — считаем пустым (не кидаем: это не рваное чтение,
      // а легальная деградация старого/битого формата).
      return { tasks: [] };
    }
    return parsed;
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const state = await this.readState();
    return state.tasks.find((t) => t.id === id) ?? null;
  }

  async listTasks(): Promise<TaskRecord[]> {
    const state = await this.readState();
    return [...state.tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Прочитать sidecar результата шага из results/. */
  async readStepResult(taskId: string, stepId: string): Promise<unknown | null> {
    const candidates = await readdir(PATHS.resultsDir).catch(() => [] as string[]);
    // Файл называется <taskId>-<stepId>.json. stepId может содержать '#' (итерация).
    const match = candidates.find((f) => f === `${taskId}-${stepId}.json`);
    if (!match) return null;
    const raw = await readFile(join(PATHS.resultsDir, match), "utf8");
    return JSON.parse(raw);
  }
}
