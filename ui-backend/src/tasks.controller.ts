import {
  Body,
  Controller,
  ConflictException,
  Get,
  HttpCode,
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
  constructor(
    private readonly reader: BlackboardReader,
    private readonly manager: ProcessManager,
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
}
