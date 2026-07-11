import { Module } from "@nestjs/common";
import { BlackboardReader } from "./blackboard-reader.service";
import { ProcessManager } from "./process-manager.service";
import { WorkflowsController } from "./workflows.controller";
import { TasksController } from "./tasks.controller";
import { ProcessesController } from "./processes.controller";
import { ModelsController } from "./models.controller";
import { ModelsService } from "./models.service";

@Module({
  controllers: [WorkflowsController, TasksController, ProcessesController, ModelsController],
  providers: [BlackboardReader, ProcessManager, ModelsService],
})
export class AppModule {}
