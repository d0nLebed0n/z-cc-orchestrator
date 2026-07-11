import {
  Body,
  Controller,
  ConflictException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { BlackboardReader } from "./blackboard-reader.service";
import { ProcessManager } from "./process-manager.service";

/**
 * Маршруты задач: список, детали, результат шага, accept.
 * Все роуты под /tasks принадлежат одному контроллеру (Nest не допускает
 * двух контроллеров с пересекающимися путями без явной конфигурации).
 */
@Controller("tasks")
export class TasksController {
  // @Inject явно: tsx (esbuild) не эмитит decorator metadata.
  constructor(
    @Inject(BlackboardReader) private readonly reader: BlackboardReader,
    @Inject(ProcessManager) private readonly manager: ProcessManager,
  ) {}

  @Get()
  async list() {
    return this.reader.listTasks();
  }

  @Get(":id")
  async one(@Param("id") id: string) {
    const task = await this.reader.getTask(id);
    if (!task) throw new NotFoundException(`task ${id} not found`);
    return task;
  }

  @Get(":id/steps/:stepId/result")
  async result(
    @Param("id") id: string,
    @Param("stepId") stepId: string,
  ) {
    const res = await this.reader.readStepResult(id, stepId);
    if (res === null) throw new NotFoundException(`result for ${id}/${stepId} not found`);
    return res;
  }

  @Post(":id/accept")
  @HttpCode(200)
  async accept(@Param("id") id: string) {
    const task = await this.reader.getTask(id);
    if (!task) throw new NotFoundException(`task ${id} not found`);
    if (task.status !== "done") {
      throw new ConflictException(`task ${id} is not 'done' (status=${task.status})`);
    }
    const res = await this.manager.runOnce(["--accept", id, "--project", task.project]);
    this.reader.invalidate();
    if (!res.ok) {
      throw new ConflictException(`accept failed: ${res.output.slice(-500)}`);
    }
    return { ok: true, message: `merged integration → main for ${id}` };
  }

  /**
   * Перезапустить задачу: берёт prompt/workflow/project из исходной задачи
   * и запускает новый subprocess через ProcessManager.start() (с SSE-стримом).
   * Возвращает clientKey — как POST /processes, чтобы UI стримил логи.
   */
  @Post(":id/restart")
  @HttpCode(200)
  async restart(@Param("id") id: string) {
    const task = await this.reader.getTask(id);
    if (!task) throw new NotFoundException(`task ${id} not found`);
    const workflowName = task.workflow.split("/").pop()?.replace(/\.ya?ml$/, "") ?? "default";
    const res = this.manager.start({
      prompt: task.prompt,
      workflow: workflowName,
      project: task.project,
    });
    if (!res.ok) {
      if (res.reason === "busy") {
        throw new ConflictException({
          message: "another task is already running",
          activeTaskId: res.activeTaskId,
        });
      }
      throw new ConflictException(res.message ?? "invalid project");
    }
    return { clientKey: res.clientKey, taskId: null };
  }
}
