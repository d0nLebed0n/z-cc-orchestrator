export type ProjectStatus = "ready" | "generating" | "failed";

export interface ProjectDto {
  slug: string;
  projectPath: string;
  status: ProjectStatus;
  knowledgeDir: string;
  lastError?: string;
}
