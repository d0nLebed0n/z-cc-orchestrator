import { Module } from "@nestjs/common";
import { BlackboardReader } from "./blackboard-reader.service";
import { ProcessManager } from "./process-manager.service";
import { WorkflowsController } from "./workflows.controller";
import { TasksController } from "./tasks.controller";
import { ProcessesController } from "./processes.controller";

@Module({
  controllers: [WorkflowsController, TasksController, ProcessesController],
  providers: [BlackboardReader, ProcessManager],
})
export class AppModule {}
