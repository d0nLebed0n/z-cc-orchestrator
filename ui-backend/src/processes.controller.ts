import {
  Body,
  BadRequestException,
  Controller,
  ConflictException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { BlackboardReader } from "./blackboard-reader.service";
import {
  ProcessManager,
  type LogLine,
  type StartOptions,
} from "./process-manager.service";

interface StartBody {
  prompt: string;
  workflow: string;
  project?: string;
}

/**
 * Запуск задачи и живой стрим её вывода.
 *
 * POST /processes        — запуск subprocess
 * GET  /processes/:key/stream  — SSE-стрим stdout/stderr + снимки state
 * POST /processes/:key/stop    — SIGTERM subprocess
 */
@Controller("processes")
export class ProcessesController {
  // @Inject явно: tsx (esbuild) не эмитит decorator metadata.
  constructor(
    @Inject(ProcessManager) private readonly manager: ProcessManager,
    @Inject(BlackboardReader) private readonly reader: BlackboardReader,
  ) {}

  @Post()
  @HttpCode(200)
  start(@Body() body: StartBody): { clientKey: string; taskId: string | null } {
    if (!body.prompt || !body.workflow) {
      throw new BadRequestException("prompt and workflow are required");
    }
    const opts: StartOptions = {
      prompt: body.prompt,
      workflow: body.workflow,
      project: body.project,
    };
    const res = this.manager.start(opts);
    if (!res.ok) {
      if (res.reason === "invalid_project") {
        throw new BadRequestException(res.message);
      }
      // busy
      throw new ConflictException({
        message: "another task is already running",
        activeTaskId: res.activeTaskId,
      });
    }
    return { clientKey: res.clientKey, taskId: null };
  }

  @Post(":key/stop")
  stop(@Param("key") key: string) {
    const r = this.manager.stop(key);
    if (!r.ok) {
      throw new NotFoundException(`cannot stop: ${r.reason}`);
    }
    return { ok: true };
  }

  /**
   * SSE-стрим. Шлёт:
   *  - backlog (буфер过去的 строк) сразу при подключении
   *  - log-события по мере прихода
   *  - state-события (снимок задачи) раз в 1.5с
   *  - exit при завершении
   */
  @Get(":key/stream")
  stream(@Param("key") key: string, @Res() res: Response): void {
    const session = this.manager.get(key);
    if (!session) {
      res.status(404).json({ message: `session ${key} not found` });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 1. Идентификатор сессии (настоящий taskId если уже известен).
    send("session", { clientKey: session.clientKey, taskId: session.taskId });

    // 2. Backlog буфера.
    for (const line of session.buffer) send("log", line);

    // 3. Подписка на новые события процесса.
    const onLog = (payload: { clientKey: string; entry: LogLine }) => {
      if (payload.clientKey === session.clientKey) send("log", payload.entry);
    };
    const onTaskId = (payload: { clientKey: string; taskId: string }) => {
      if (payload.clientKey === session.clientKey) send("task-id", { taskId: payload.taskId });
    };
    const onExit = (payload: { clientKey: string; code: number | null; success: boolean }) => {
      if (payload.clientKey !== session.clientKey) return;
      send("exit", { code: payload.code, success: payload.success });
      cleanup();
      res.end();
    };
    this.manager.on("log", onLog);
    this.manager.on("task-id", onTaskId);
    this.manager.on("exit", onExit);

    // 4. Периодический снимок состояния задачи для прогресса шагов.
    let lastTaskJson = "";
    const stateTimer = setInterval(async () => {
      const id = session.taskId;
      if (!id) return;
      const task = await this.reader.getTask(id).catch(() => null);
      if (!task) return;
      const json = JSON.stringify(task);
      if (json !== lastTaskJson) {
        lastTaskJson = json;
        send("state", task);
      }
      this.reader.invalidate();
    }, 1500);

    const cleanup = () => {
      clearInterval(stateTimer);
      this.manager.off("log", onLog);
      this.manager.off("task-id", onTaskId);
      this.manager.off("exit", onExit);
    };

    res.on("close", cleanup);
  }

  /** Независимый heartbeat-эндпоинт (не используется фронт-стримом). */
  @Get(":key/state")
  async state(@Param("key") key: string) {
    const session = this.manager.get(key);
    if (!session) throw new NotFoundException(`session ${key} not found`);
    const task = session.taskId ? await this.reader.getTask(session.taskId) : null;
    return {
      clientKey: session.clientKey,
      taskId: session.taskId,
      exited: session.exited,
      exitCode: session.exitCode,
      success: session.success,
      task,
    };
  }
}
