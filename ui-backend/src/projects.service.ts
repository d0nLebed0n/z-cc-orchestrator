import { Injectable, Logger, Inject } from "@nestjs/common";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProcessManager } from "./process-manager.service";
import { validateProjectPath, validationMessage } from "./path-utils";

const execFileAsync = promisify(execFile);

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

  // @Inject явно: tsx (esbuild) не эмитит decorator metadata для constructors,
  // поэтому неявная DI по типу не работает для provider→provider зависимостей.
  constructor(@Inject(ProcessManager) private readonly processManager: ProcessManager) {}

  /**
   * Открыть системный picker директории на машине, где запущен ui-backend.
   * Это локальный desktop-flow: браузер не может безопасно отдать абсолютный
   * путь через обычный file input, поэтому путь выбирает backend-процесс.
   */
  async pickDirectory(): Promise<{ projectPath: string | null }> {
    try {
      const projectPath =
        process.platform === "darwin"
          ? await pickDirectoryMac()
          : process.platform === "win32"
            ? await pickDirectoryWindows()
            : await pickDirectoryLinux();
      return { projectPath };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "cancelled") return { projectPath: null };
      throw e;
    }
  }

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

    // review #12 (review-2026-07-13): запретить параллельный init, пока активна
    // другая задача — иначе два CLI-процесса гоняют один state.json (review #7).
    // Backend/MCP/runOnce теперь все уважают global run lock, но hasAlive —
    // быстрая frontend-facing проверка, чтобы дать понятную ошибку в UI.
    if (this.processManager.hasAlive()) {
      throw new Error("another task is already running. Wait for it before initializing a project.");
    }

    // runOnce: запускает CLI и ждёт завершения (без SSE-стрима).
    // UI показывает "generating..." и опрашивает GET /projects/:slug для статуса.
    // TODO(#12): превратить в tracked session (clientKey + SSE), чтобы UI видел
    // прогресс и мог остановить. Сейчас — blocking, как accept.
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
    // review #34 (review-2026-07-13): hasAlive-проверка против гонки blackboard,
    // как в open(). Раньше regenerate её не имел — можно было запустить
    // параллельный init поверх активной задачи (рваная запись state.json).
    if (this.processManager.hasAlive()) {
      throw new Error("another task is already running. Wait for it before regenerating project context.");
    }
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

async function pickDirectoryMac(): Promise<string> {
  const script = [
    'set selectedFolder to choose folder with prompt "Выбери корень git-репозитория"',
    "POSIX path of selectedFolder",
  ].join("\n");
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  return normalizePickerOutput(stdout);
}

async function pickDirectoryWindows(): Promise<string> {
  const command = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
    "$dialog.Description = 'Выбери корень git-репозитория';",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  Write-Output $dialog.SelectedPath",
    "} else {",
    "  exit 2",
    "}",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-Command",
      command,
    ]);
    return normalizePickerOutput(stdout);
  } catch (e) {
    if (isExitCode(e, 2)) throw new Error("cancelled");
    throw e;
  }
}

async function pickDirectoryLinux(): Promise<string> {
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: "zenity", args: ["--file-selection", "--directory", "--title=Выбери корень git-репозитория"] },
    { cmd: "kdialog", args: ["--getexistingdirectory", process.cwd(), "Выбери корень git-репозитория"] },
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.cmd, candidate.args);
      return normalizePickerOutput(stdout);
    } catch (e) {
      if (isExitCode(e, 1)) throw new Error("cancelled");
      lastError = e;
    }
  }
  throw new Error(
    `Не удалось открыть системный выбор папки. Установи zenity/kdialog или введи путь вручную. ${String(lastError ?? "")}`,
  );
}

function normalizePickerOutput(stdout: string): string {
  const selected = stdout.trim();
  if (!selected) throw new Error("cancelled");
  return selected.length > 1 ? selected.replace(/\/$/, "") : selected;
}

function isExitCode(e: unknown, code: number): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}
