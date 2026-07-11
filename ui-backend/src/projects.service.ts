import { Injectable, Logger } from "@nestjs/common";
import { ProcessManager } from "./process-manager.service";
import { validateProjectPath, validationMessage } from "./path-utils";

export interface ProjectDto {
  slug: string;
  projectPath: string;
  status: "ready" | "generating" | "failed";
  knowledgeDir: string;
  lastError?: string;
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(private readonly processManager: ProcessManager) {}

  /**
   * Открыть проект: валидация пути → запуск CLI --init-project (который сам
   * вызывает getOrCreateProject, создаёт скелет, запускает architect, пишет
   * 00-project/*.md, обновляет статус в реестре) → чтение результата из реестра.
   *
   * ui-backend не импортирует engine напрямую (по существующей архитектуре) —
   * взаимодействие через subprocess CLI. slug определяется внутри CLI
   * (getOrCreateProject с учётом коллизий), backend не дублирует slug-логику.
   */
  async open(projectPath: string): Promise<{ project: ProjectDto; clientKey: string | null }> {
    const v = validateProjectPath(projectPath);
    if (!v.ok) {
      throw new Error(validationMessage(v));
    }
    const absPath = v.path;

    // runOnce: запускает CLI и ждёт завершения (без SSE-стрима).
    // UI показывает "generating..." и опрашивает GET /projects/:slug для статуса.
    const result = await this.processManager.runOnce([
      "--project", absPath,
      "--init-project",
    ]);

    if (!result.ok) {
      this.logger.error(`init-project failed: ${result.output.slice(-500)}`);
      throw new Error(`project init failed: ${result.output.slice(-500)}`);
    }

    // CLI уже записал ready/failed в реестр. Читаем запись по projectPath.
    const project = await this.readFromRegistry(absPath);
    return { project, clientKey: null };
  }

  /** Прочитать запись из registry.json (дублирует чтение engine, но без импорта engine). */
  private async readFromRegistry(projectPath: string): Promise<ProjectDto> {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const registryFile = join(homedir(), ".orchestrator", "projects.json");
    if (!existsSync(registryFile)) {
      throw new Error("projects registry not found");
    }
    const raw = await readFile(registryFile, "utf8");
    const reg = JSON.parse(raw) as { projects: ProjectDto[] };
    const entry = reg.projects.find((p) => p.projectPath === projectPath);
    if (!entry) throw new Error(`project not in registry: ${projectPath}`);
    return entry;
  }

  async list(): Promise<ProjectDto[]> {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const registryFile = join(homedir(), ".orchestrator", "projects.json");
    if (!existsSync(registryFile)) return [];
    const raw = await readFile(registryFile, "utf8");
    const reg = JSON.parse(raw) as { projects: ProjectDto[] };
    return reg.projects;
  }

  async getBySlug(slug: string): Promise<ProjectDto> {
    const all = await this.list();
    const entry = all.find((p) => p.slug === slug);
    if (!entry) throw new Error(`project slug not found: ${slug}`);
    return entry;
  }

  async regenerate(slug: string): Promise<{ project: ProjectDto }> {
    const entry = await this.getBySlug(slug);
    const result = await this.processManager.runOnce([
      "--project", entry.projectPath,
      "--init-project",
      "--project-slug", slug,
    ]);
    if (!result.ok) {
      throw new Error(`regenerate failed: ${result.output.slice(-500)}`);
    }
    const project = await this.readFromRegistry(entry.projectPath);
    return { project };
  }
}
