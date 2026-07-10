import { Injectable, Logger } from "@nestjs/common";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config";
import type { BlackboardState, TaskRecord } from "./types";

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
    const state = await this.readStateFromDisk();
    this.cache = { at: now, state };
    return state;
  }

  /** Принудительно сбросить кеш (после запуска/остановки задачи). */
  invalidate(): void {
    this.cache = null;
  }

  private async readStateFromDisk(): Promise<BlackboardState> {
    if (!existsSync(PATHS.stateFile)) {
      return { tasks: [] };
    }
    try {
      const raw = await readFile(PATHS.stateFile, "utf8");
      const parsed = JSON.parse(raw) as BlackboardState;
      if (!parsed || !Array.isArray(parsed.tasks)) {
        return { tasks: [] };
      }
      return parsed;
    } catch (e) {
      this.logger.error(`Failed to read state.json: ${(e as Error).message}`);
      return { tasks: [] };
    }
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
