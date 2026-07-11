import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { ModelsService } from "./models.service";
import type { ModelInputDto, UpdateRolesDto } from "./models.dto";

@Controller("models")
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  async list() {
    return this.models.list();
  }

  @Post()
  async create(@Body() body: ModelInputDto) {
    try {
      return await this.models.create(body);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Put(":id")
  async update(@Param("id") id: string, @Body() body: Partial<ModelInputDto>) {
    try {
      return await this.models.update(id, body);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    try {
      await this.models.remove(id);
      return { ok: true };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Get("detect")
  async detect(@Query("kind") kind: "claude-binary" | "codex-binary") {
    if (kind !== "claude-binary" && kind !== "codex-binary") {
      throw new BadRequestException("kind must be claude-binary or codex-binary");
    }
    return this.models.detectBinary(kind);
  }

  @Put("roles")
  async updateRoles(@Body() body: UpdateRolesDto) {
    await this.models.updateRoles(body);
    return { ok: true };
  }
}
