import {
  Controller, Get, Post, Body, Param, Inject,
  BadRequestException, NotFoundException, InternalServerErrorException,
} from "@nestjs/common";
import { ProjectsService } from "./projects.service";

interface OpenBody {
  projectPath: string;
}

@Controller("projects")
export class ProjectsController {
  // @Inject явно: tsx (esbuild) не эмитит decorator metadata, поэтому
  // неявная DI по типу параметра конструктора не работает.
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get()
  async list() {
    return this.projects.list();
  }

  @Post("open")
  async open(@Body() body: OpenBody) {
    if (!body.projectPath) {
      throw new BadRequestException("projectPath is required");
    }
    try {
      return await this.projects.open(body.projectPath);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("не существует") || msg.includes("не git") || msg.includes("путь")) {
        throw new BadRequestException(msg);
      }
      throw new InternalServerErrorException(msg);
    }
  }

  @Post("pick-directory")
  async pickDirectory() {
    try {
      return await this.projects.pickDirectory();
    } catch (e) {
      throw new InternalServerErrorException((e as Error).message);
    }
  }

  @Get(":slug")
  async getBySlug(@Param("slug") slug: string) {
    try {
      return await this.projects.getBySlug(slug);
    } catch (e) {
      throw new NotFoundException((e as Error).message);
    }
  }

  @Post(":slug/regenerate")
  async regenerate(@Param("slug") slug: string) {
    try {
      return await this.projects.regenerate(slug);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("not found")) throw new NotFoundException(msg);
      throw new InternalServerErrorException(msg);
    }
  }
}
