import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Inject,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from "@nestjs/common";
import { ModelsService } from "./models.service";
import type { ModelInputDto, UpdateRolesDto } from "./models.dto";

@Controller("models")
export class ModelsController {
  // @Inject явно: tsx (esbuild) не эмитит decorator metadata.
  constructor(@Inject(ModelsService) private readonly models: ModelsService) {}

  @Get()
  async list() {
    return this.models.list();
  }

  // Static paths must be declared BEFORE parametric (:id) routes so that
  // Express/NestJS does not match them against the :id segment.
  @Get("detect")
  async detect(@Query("kind") kind: "claude-binary" | "codex-binary") {
    if (kind !== "claude-binary" && kind !== "codex-binary") {
      throw new BadRequestException("kind must be claude-binary or codex-binary");
    }
    return this.models.detectBinary(kind);
  }

  // Static path: MUST come before any parametric @Get(":id") route, otherwise
  // GET /models/roles would be captured by the :id segment (id="roles").
  @Get("roles")
  async getRoles() {
    return this.models.getRoles();
  }

  @Post()
  async create(@Body() body: ModelInputDto) {
    try {
      return await this.models.create(body);
    } catch (e) {
      // Expected domain error: duplicate id → 400 with the message.
      const msg = (e as Error).message;
      if (msg.includes("already exists")) throw new BadRequestException(msg);
      // Unexpected (filesystem/parse) → 500, do not leak internals.
      throw new InternalServerErrorException("Failed to create model");
    }
  }

  // Static path: MUST come before @Put(":id"), otherwise PUT /models/roles
  // would be captured by the :id route with id="roles".
  @Put("roles")
  async updateRoles(@Body() body: UpdateRolesDto) {
    await this.models.updateRoles(body);
    return { ok: true };
  }

  @Put(":id")
  async update(@Param("id") id: string, @Body() body: Partial<ModelInputDto>) {
    try {
      return await this.models.update(id, body);
    } catch (e) {
      const msg = (e as Error).message;
      // Expected domain error: missing model → 404 with the message.
      if (msg.includes("not found")) throw new NotFoundException(msg);
      // Unexpected (filesystem/parse) → 500, do not leak internals.
      throw new InternalServerErrorException("Failed to update model");
    }
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    try {
      await this.models.remove(id);
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("not found")) throw new NotFoundException(msg);
      throw new InternalServerErrorException("Failed to remove model");
    }
  }
}
