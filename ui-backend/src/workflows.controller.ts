import { Controller, Get } from "@nestjs/common";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PATHS } from "./config";
import type { WorkflowDto } from "./types";

/** GET /workflows — список воркфлоу из workflows/*.yaml. */
@Controller("workflows")
export class WorkflowsController {
  @Get()
  async list(): Promise<WorkflowDto[]> {
    if (!existsSync(PATHS.workflowsDir)) return [];
    const files = (await readdir(PATHS.workflowsDir)).filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
    );
    const out: WorkflowDto[] = [];
    for (const f of files) {
      try {
        const raw = await readFile(join(PATHS.workflowsDir, f), "utf8");
        const wf = parseYaml(raw) as {
          name?: string;
          description?: string;
          steps?: { agent: string; role: string }[];
        };
        const name = wf.name ?? f.replace(/\.ya?ml$/, "");
        const desc = wf.description ? String(wf.description).split("\n")[0] ?? "" : "";
        const steps = Array.isArray(wf.steps)
          ? wf.steps.map((s) => `${s.agent}(${s.role})`).join(" → ")
          : "";
        out.push({ name, description: desc, steps });
      } catch {
        // пропустить невалидный yaml
      }
    }
    return out;
  }
}
