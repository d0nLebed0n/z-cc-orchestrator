# Project Knowledge Directory & Context Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a centrally-stored project knowledge directory (`~/.orchestrator/projects/<slug>/`) with an `architect` role that generates `00-project/` context, and inject that context into `buildWorkerPrompt` so every model (claude/codex/glm/ollama) receives project knowledge on each step.

**Architecture:** New `src/project-knowledge/` module (slug, registry, context, templates) with zero changes to engine-core dispatch. One optional parameter `projectContext?: string` added to `buildWorkerPrompt`. The `architect` role (new 7th role) runs via a `project-init` workflow and returns JSON parsed into `00-project/*.md`. A UI button "Открыть проект" in RunForm triggers generation via a new backend endpoint.

**Tech Stack:** Node.js + TypeScript (ESM, zod, yaml, async-mutex), NestJS backend, Next.js (App Router) + React frontend.

## Global Constraints

- ESM modules (`.ts` extensions in imports).
- No database — JSON files with async-mutex for write serialization (follow `blackboard.ts` pattern).
- Knowledge dir lives at `~/.orchestrator/projects/<slug>/` (never inside the target project, never in its git).
- `architect` is a non-editing role: no worktree, no file writes to the project repo (read-only scan).
- Context injection degrades gracefully: missing knowledge dir → `projectContext = null` → `buildWorkerPrompt` works as before.
- `buildWorkerPrompt` is called in exactly ONE place (`runner.ts:241` inside `runWorkerOnly`); fan-out subtasks also go through `runWorkerOnly`, so a single injection point covers both paths.
- All UI text in Russian (matching existing UI).

---

## File Structure

**New files:**
- `src/project-knowledge/slug.ts` — `slugFromPath(projectPath)`: sanitize basename + collision suffix.
- `src/project-knowledge/registry.ts` — `~/.orchestrator/projects.json` CRUD (getOrCreate/find/update/list) with mutex.
- `src/project-knowledge/context.ts` — `loadProjectContextCache(slug)` + `buildProjectContext(role, cache, activeTask)`.
- `src/project-knowledge/architect.ts` — `parseArchitectJson(output)` + `writeProjectFiles(slug, parsed)` + `scanProjectStructure(projectPath)`.
- `src/project-knowledge/templates/` — static skeleton files copied on project creation.
- `workflows/project-init.yaml` — single-step workflow using `architect` role.
- `ui-backend/src/projects.service.ts` — backend business logic.
- `ui-backend/src/projects.controller.ts` — REST API for projects.
- `scripts/smoke-project-init.ts` — integration smoke test.

**Modified files:**
- `src/envelope.ts` — add `architect` to `RoleSchema`.
- `src/workflow.ts` — add `architect` to inline `role` enum in `WorkflowStepSchema`.
- `src/model-config-dto.ts` — `RoleMapSchema` already uses `RoleSchema` (no change needed once `RoleSchema` is extended).
- `src/model-registry.ts` — add `architect: "claude"` to `DEFAULT_CONFIG.roles` + migration.
- `src/prompts/roles.ts` — add `architectPrompt` + `projectContext` param to `buildWorkerPrompt`.
- `src/runner.ts` — load `ctxCache`/`activeTask` in `runWorkflow`, pass through `WorkerOnlyOpts`, archive on completion.
- `src/cli.ts` — `--init-project` and `--project-slug` flags.
- `.orchestrator/models.yaml` — add `architect: claude` to roles.
- `ui-backend/src/app.module.ts` — register `ProjectsController`/`ProjectsService`.
- `ui-web/src/shared/api/index.ts` — `openProject`/`getProject`/`listProjects` methods.
- `ui-web/src/entities/model/index.ts` — add `architect` to `Role`/`ROLE_LABELS`/`ROLE_DESCRIPTIONS`.
- `ui-web/src/widgets/settings-roles/SettingsRoles.tsx` — add `architect` to `ALL_ROLES`.
- `ui-web/src/widgets/run-form/RunForm.tsx` — "Открыть проект" button + status indicator.

---

## Task 1: Slug generation utility

**Files:**
- Create: `src/project-knowledge/slug.ts`

**Interfaces:**
- Produces: `slugFromPath(projectPath: string): string` — sanitized slug; appends `-<8hex>` collision suffix when needed.

- [ ] **Step 1: Create the slug module**

```typescript
// src/project-knowledge/slug.ts
import { basename } from "node:path";
import { createHash } from "node:crypto";

/**
 * Санитизировать basename пути в slug: lowercase, не-[a-z0-9] → '-', схлопывание.
 * Коллизии (разные пути дают один slug) не разрешаются здесь — registry отвечает
 * за добавление хэш-суффикса при коллизии (нужен доступ к существующим записям).
 */
function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "project";
}

/**
 * Короткий хэш абсолютного пути (первые 8 hex символов SHA-256).
 * Используется как суффикс при slug-коллизии (два разных пути → один basename).
 */
export function pathHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 8);
}

/**
 * Базовый slug из пути проекта (без коллизионного суффикса).
 */
export function baseSlug(projectPath: string): string {
  return sanitize(basename(projectPath));
}

/**
 * Slug с коллизионным суффиксом. Вызывается registry, когда baseSlug уже занят
 * другим путём. Суффикс = первые 8 hex символов SHA-256 абсолютного пути.
 */
export function slugFromPath(projectPath: string, collision = false): string {
  const base = baseSlug(projectPath);
  return collision ? `${base}-${pathHash(projectPath)}` : base;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx --eval "import('./src/project-knowledge/slug.ts').then(m => console.log(m.slugFromPath('/Users/ilya/Desktop/My-Cool-Project')))"`
Expected: prints `my-cool-project`

- [ ] **Step 3: Commit**

```bash
git add src/project-knowledge/slug.ts
git commit -m "feat(project-knowledge): slug generation utility"
```

---

## Task 2: Project registry

**Files:**
- Create: `src/project-knowledge/registry.ts`

**Interfaces:**
- Consumes: `slugFromPath`, `pathHash` from `./slug.ts`.
- Produces: `ProjectRegistryEntry`, `ProjectRegistry`, `getOrCreateProject`, `findProject`, `updateProjectStatus`, `listProjects`, `knowledgeDirFor`.

- [ ] **Step 1: Create the registry module**

```typescript
// src/project-knowledge/registry.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Mutex } from "async-mutex";
import { slugFromPath, pathHash } from "./slug.ts";

/** Корень централизованного хранилища знаний проектов. */
export const PROJECTS_ROOT = join(homedir(), ".orchestrator", "projects");
export const REGISTRY_FILE = join(homedir(), ".orchestrator", "projects.json");

export type ProjectStatus = "ready" | "generating" | "failed";

export interface ProjectRegistryEntry {
  slug: string;
  projectPath: string;
  createdAt: string;
  lastOpenedAt: string;
  status: ProjectStatus;
  knowledgeDir: string;
  generatorModel?: string;
  lastError?: string;
}

interface ProjectRegistry {
  projects: ProjectRegistryEntry[];
}

const mutex = new Mutex();

/** Путь к директории знаний для slug (без проверки существования). */
export function knowledgeDirFor(slug: string): string {
  return join(PROJECTS_ROOT, slug);
}

async function readRegistry(): Promise<ProjectRegistry> {
  if (!existsSync(REGISTRY_FILE)) return { projects: [] };
  const raw = await readFile(REGISTRY_FILE, "utf8");
  try {
    return JSON.parse(raw) as ProjectRegistry;
  } catch {
    return { projects: [] };
  }
}

async function writeRegistry(reg: ProjectRegistry): Promise<void> {
  await mkdir(join(homedir(), ".orchestrator"), { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(reg, null, 2), "utf8");
}

/**
 * Найти запись по slug. null если не найдена.
 */
export async function findProject(slug: string): Promise<ProjectRegistryEntry | null> {
  const reg = await readRegistry();
  return reg.projects.find((p) => p.slug === slug) ?? null;
}

/**
 * Найти запись по пути проекта (учитывает коллизии: сначала baseSlug, потом с хэшем).
 */
async function findByPath(projectPath: string): Promise<ProjectRegistryEntry | null> {
  const reg = await readRegistry();
  return reg.projects.find((p) => p.projectPath === projectPath) ?? null;
}

/**
 * Получить или создать запись проекта. Создаёт скелет директории знаний при
 * первом обращении. При коллизии baseSlug (другой путь с тем же basename)
 * добавляет хэш-суффикс.
 *
 * Возвращает entry. Если проект новый — status="generating" (architect ещё не
 * запускался). Если существующий — обновляет lastOpenedAt.
 */
export async function getOrCreateProject(projectPath: string): Promise<ProjectRegistryEntry> {
  return mutex.runExclusive(async () => {
    // Сначала ищем существующую запись по точному пути.
    const existing = await findByPath(projectPath);
    if (existing) {
      existing.lastOpenedAt = new Date().toISOString();
      await writeRegistry(await readRegistry().then((r) => {
        const idx = r.projects.findIndex((p) => p.slug === existing.slug);
        if (idx !== -1) r.projects[idx] = existing;
        return r;
      }));
      return existing;
    }

    // Новый проект: определяем slug с учётом коллизий.
    const reg = await readRegistry();
    let slug = slugFromPath(projectPath, false);
    // Коллизия: другой путь уже занял этот baseSlug → добавляем хэш.
    if (reg.projects.some((p) => p.slug === slug)) {
      slug = slugFromPath(projectPath, true);
    }

    const knowledgeDir = knowledgeDirFor(slug);
    await mkdir(knowledgeDir, { recursive: true });

    const now = new Date().toISOString();
    const entry: ProjectRegistryEntry = {
      slug,
      projectPath,
      createdAt: now,
      lastOpenedAt: now,
      status: "generating",
      knowledgeDir,
    };
    reg.projects.push(entry);
    await writeRegistry(reg);
    return entry;
  });
}

/**
 * Обновить статус проекта (ready/failed) и опционально lastError.
 */
export async function updateProjectStatus(
  slug: string,
  status: ProjectStatus,
  lastError?: string,
): Promise<void> {
  return mutex.runExclusive(async () => {
    const reg = await readRegistry();
    const idx = reg.projects.findIndex((p) => p.slug === slug);
    if (idx === -1) throw new Error(`updateProjectStatus: project '${slug}' not found`);
    reg.projects[idx]!.status = status;
    if (lastError !== undefined) reg.projects[idx]!.lastError = lastError;
    else if (status === "ready") reg.projects[idx]!.lastError = undefined;
    await writeRegistry(reg);
  });
}

/**
 * Список всех известных проектов (для будущего recent-list).
 */
export async function listProjects(): Promise<ProjectRegistryEntry[]> {
  const reg = await readRegistry();
  return reg.projects;
}
```

- [ ] **Step 2: Verify it compiles and basic flow works**

Run:
```bash
npx tsx --eval "
import('./src/project-knowledge/registry.ts').then(async (m) => {
  const e = await m.getOrCreateProject('/tmp/test-slug-project');
  console.log('slug:', e.slug, 'status:', e.status, 'dir:', e.knowledgeDir);
  const e2 = await m.getOrCreateProject('/tmp/test-slug-project');
  console.log('same path returns same slug:', e2.slug === e.slug);
  await m.updateProjectStatus(e.slug, 'ready');
  const e3 = await m.findProject(e.slug);
  console.log('status updated:', e3?.status);
})
"
```
Expected: slug `test-slug-project`, status `generating`, same path returns same slug, status updated to `ready`.

- [ ] **Step 3: Commit**

```bash
git add src/project-knowledge/registry.ts
git commit -m "feat(project-knowledge): project registry (projects.json CRUD)"
```

---

## Task 3: Knowledge directory templates

**Files:**
- Create: `src/project-knowledge/templates/00-project/.gitkeep`
- Create: `src/project-knowledge/templates/01-workflows/feature-workflow.md` (and 3 siblings)
- Create: `src/project-knowledge/templates/02-prompts/01-discovery.md` (and 4 siblings)
- Create: `src/project-knowledge/templates/03-tasks/active-task.md`, `task-template.md`, `task-checklist.md`
- Create: `src/project-knowledge/templates/04-skills/.gitkeep`
- Create: `src/project-knowledge/templates/05-context/file-allowlist.md` (and 3 siblings)
- Create: `src/project-knowledge/templates/06-mcp/.gitkeep`
- Create: `src/project-knowledge/templates/07-output/decisions.md`, `touched-files.md`, `validation-report.md`, `plan.md`

**Interfaces:**
- Produces: static directory tree copied verbatim into `~/.orchestrator/projects/<slug>/` by `skeletonDir()` helper.

- [ ] **Step 1: Create all template files**

Create the directory tree. Each file is small markdown with a header explaining its purpose and a TODO placeholder. Use `.gitkeep` for empty sections (`00-project/`, `04-skills/`, `06-mcp/`).

Template content for `03-tasks/active-task.md`:
```markdown
# Active Task
status: idle
updated:

## Goal

## Scope
- target_paths: none

## Acceptance Criteria

## Notes
```

Template content for `03-tasks/task-template.md`:
```markdown
# Task Template

## Title
<name>

## Goal
<what to achieve>

## Why
<motivation>

## Scope
- target_paths: <paths or none>

## Acceptance Criteria
- [ ] <criterion>

## Files
<expected touch points>
```

Template content for `03-tasks/task-checklist.md`:
```markdown
# Pre-Done Checklist
- [ ] Tests pass
- [ ] No debug/TODO/secrets left
- [ ] Diff is minimal and coherent
- [ ] Commits are atomic
```

Template content for `05-context/file-allowlist.md`:
```markdown
# File Allowlist
<!-- Files the AI may edit freely without approval. Add paths relative to project root. -->
<!-- Example: src/collections/**, src/components/** -->
(none yet)
```

Template content for `05-context/file-blocklist.md`:
```markdown
# File Blocklist
<!-- Files the AI must NOT touch without explicit approval. -->
<!-- Example: Dockerfile, src/auth/**, package.json -->
(none yet)
```

Template content for `05-context/naming-rules.md`:
```markdown
# Naming Rules
<!-- Project naming conventions (files, slugs, fields). -->
<!-- Example: PascalCase files, lowercase plural slugs, camelCase fields. -->
(none yet)
```

Template content for `05-context/done-definition.md`:
```markdown
# Definition of Done
<!-- Что считается «готовым» в этом проекте. -->
- Код реализован и соответствует стилю проекта
- Тесты (если есть) проходят
- Дифф минимален и связен
- Нет отладочного кода, TODO, секретов
```

Template content for `07-output/decisions.md`:
```markdown
# Decisions Log
<!-- Append-only. Each entry: task, date, summary, outcome. -->
```

Template content for `07-output/touched-files.md`:
```markdown
# Touched Files Log
<!-- Append-only. Each entry: task, date, files changed. -->
```

Template content for `07-output/validation-report.md`:
```markdown
# Validation Report
<!-- Append-only. Validation history per task. -->
```

Template content for `07-output/plan.md`:
```markdown
# Current Objective
<!-- High-level current goal. Updated by architect or manually. -->
(none yet)
```

For `01-workflows/*.md` and `02-prompts/*.md`, create each file with a short header:
```markdown
# Feature Workflow
<!-- Process playbook for feature work. Customize per project. -->
(describe steps: discovery → planning → implementation → self-check → final-report)
```
(Repeat for `bugfix-workflow.md`, `refactor-workflow.md`, `research-workflow.md`.)

For `02-prompts/01-discovery.md` through `05-final-report.md`:
```markdown
# Discovery Prompt
<!-- Stage 1: read project context, no code. Output understanding of the task. -->
```
(Repeat for `02-planning.md`, `03-implementation.md`, `04-self-check.md`, `05-final-report.md`.)

- [ ] **Step 2: Add a `skeletonDir()` export and `copySkeleton` helper**

Create `src/project-knowledge/skeleton.ts`:
```typescript
// src/project-knowledge/skeleton.ts
import { cp, mkdir, existsSync } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Путь к шаблонам (коммитятся в репо). */
export const TEMPLATES_DIR = join(__dirname, "templates");

/**
 * Скопировать скелет директории знаний из templates/ в knowledgeDir.
 * Рекурсивное копирование. Если knowledgeDir уже существует — не падает
 * (cp с recursive:true мержит).
 */
export async function copySkeleton(knowledgeDir: string): Promise<void> {
  if (!existsSync(TEMPLATES_DIR)) {
    throw new Error(`Templates directory not found: ${TEMPLATES_DIR}`);
  }
  await mkdir(knowledgeDir, { recursive: true });
  await cp(TEMPLATES_DIR, knowledgeDir, { recursive: true });
}
```

- [ ] **Step 3: Verify templates copy works**

Run:
```bash
npx tsx --eval "
import('./src/project-knowledge/skeleton.ts').then(async (m) => {
  await m.copySkeleton('/tmp/test-skeleton-out');
  const fs = await import('node:fs/promises');
  const entries = await fs.readdir('/tmp/test-skeleton-out', { recursive: true });
  console.log(entries.sort());
})
"
```
Expected: lists all template files including `00-project/.gitkeep`, `03-tasks/active-task.md`, etc.

- [ ] **Step 4: Commit**

```bash
git add src/project-knowledge/templates/ src/project-knowledge/skeleton.ts
git commit -m "feat(project-knowledge): static templates + skeleton copy"
```

---

## Task 4: Extend Role union with `architect`

**Files:**
- Modify: `src/envelope.ts:13-20` (RoleSchema)
- Modify: `src/workflow.ts:20` (inline role enum in WorkflowStepSchema)
- Modify: `src/model-registry.ts:33-41` (DEFAULT_CONFIG.roles)
- Modify: `ui-web/src/entities/model/index.ts:3,17-33` (Role, ROLE_LABELS, ROLE_DESCRIPTIONS)
- Modify: `ui-web/src/widgets/settings-roles/SettingsRoles.tsx:25` (ALL_ROLES)

**Interfaces:**
- Produces: `Role` type now includes `"architect"`. All schemas and UI label maps updated consistently.

- [ ] **Step 1: Add `architect` to RoleSchema in envelope.ts**

In `src/envelope.ts`, change the enum:
```typescript
export const RoleSchema = z.enum([
  "plan",
  "implement",
  "review",
  "refine",
  "fix",
  "final",
  "architect",
]);
```

- [ ] **Step 2: Add `architect` to inline role enum in workflow.ts**

In `src/workflow.ts` line 20, the `WorkflowStepSchema.role` is an inline `z.enum`. Change it to include `architect`:
```typescript
  role: z.enum(["plan", "implement", "review", "refine", "fix", "final", "architect"]),
```

- [ ] **Step 3: Add `architect: "claude"` to DEFAULT_CONFIG.roles in model-registry.ts**

In `src/model-registry.ts`, add to `DEFAULT_CONFIG.roles`:
```typescript
  roles: {
    plan: "claude",
    implement: "glm",
    review: "codex",
    refine: "glm",
    fix: "glm",
    final: "claude",
    architect: "claude",
  },
```

- [ ] **Step 4: Add migration for existing models.yaml missing `architect` role**

In `src/model-registry.ts`, in `loadModelsConfig`, after `cached = parsed;` (line 58) add migration:
```typescript
    cached = parsed;
    // Миграция: добавить роль architect, если её нет (новая роль с этого коммита).
    if (!cached.roles.architect) {
      cached.roles.architect = "claude";
      writeFileSync(modelsPath, stringifyYaml(cached), "utf8");
    }
```
Note: `RoleMapSchema` in `model-config-dto.ts` uses `z.record(RoleSchema, ...)` so once `RoleSchema` includes `architect`, the record accepts it. But `z.record` does NOT require all keys — existing configs without `architect` still parse. The migration adds it explicitly.

- [ ] **Step 5: Update UI Role type and label maps**

In `ui-web/src/entities/model/index.ts`:
```typescript
export type Role = "plan" | "implement" | "review" | "refine" | "fix" | "final" | "architect";
```
Add to `ROLE_LABELS`:
```typescript
  architect: "Архитектор",
```
Add to `ROLE_DESCRIPTIONS`:
```typescript
  architect: "Генерация контекста проекта при открытии",
```

- [ ] **Step 6: Add architect to ALL_ROLES in SettingsRoles.tsx**

In `ui-web/src/widgets/settings-roles/SettingsRoles.tsx` line 25:
```typescript
const ALL_ROLES: Role[] = ["plan", "implement", "review", "refine", "fix", "final", "architect"];
```

- [ ] **Step 7: Add architect to live models.yaml**

In `.orchestrator/models.yaml`, add `architect: claude` to the `roles:` block (after `final`).

- [ ] **Step 8: Verify engine still loads config**

Run: `npx tsx --eval "import('./src/model-registry.ts').then(m => { m.loadModelsConfig('./.orchestrator'); console.log(m.getRoleMap()); })"`
Expected: prints role map including `architect: 'claude'`.

- [ ] **Step 9: Commit**

```bash
git add src/envelope.ts src/workflow.ts src/model-registry.ts .orchestrator/models.yaml ui-web/src/entities/model/index.ts ui-web/src/widgets/settings-roles/SettingsRoles.tsx
git commit -m "feat(roles): add architect role (7th role for project knowledge generation)"
```

---

## Task 5: Architect prompt + projectContext param in buildWorkerPrompt

**Files:**
- Modify: `src/prompts/roles.ts` — add `architectPrompt`, extend `buildWorkerPrompt` with `projectContext`.

**Interfaces:**
- Produces: `architectPrompt(agent)` function, `buildWorkerPrompt` accepts optional `projectContext?: string`.
- Consumes: `Role` from `../envelope.ts` (now includes `architect`).

- [ ] **Step 1: Add architectPrompt function**

In `src/prompts/roles.ts`, add before the `ROLE_PROMPTS` record (after `finalPrompt`, around line 282):
```typescript
/** Роль architect: сканирует структуру проекта и генерирует 00-project/*.md. Не пишет код. */
function architectPrompt(agent: string): string {
  return [
    commonHeader(agent),
    "",
    "ROLE: ARCHITECT",
    "You scan the project structure and produce a knowledge-base document for the",
    "00-project/ section of this project's knowledge directory. You do NOT write",
    "application code — only descriptive markdown.",
    "",
    "REQUIREMENTS:",
    "- Inspect the project root, package.json, README, and directory structure.",
    "- Identify: what the project is (product), how it's built (architecture),",
    "  where key code lives (code_map), domain terms (glossary), and tech-stack",
    "  conventions (stack_rules).",
    "- If the project is empty (no src/, empty package.json), output TODO stubs",
    '  with a note "project is empty — fill after the first task".',
    "- Be concise but complete. Use markdown formatting inside each JSON value.",
    "- If you run low on budget, prioritize architecture and code_map; mark",
    '  unfinished sections with "...".',
    "",
    "OUTPUT FORMAT (STRICT JSON — the runner parses it and writes files):",
    "Emit ONLY a JSON object (optionally in a ```json fence). Each value is a",
    "markdown string for one file in 00-project/:",
    '  { "product": "...", "architecture": "...", "code_map": "...", "glossary": "...", "stack_rules": "..." }',
    "",
    "SUCCESS CRITERION: valid JSON with all 5 keys. Each value is non-empty",
    "markdown describing the corresponding aspect of the project.",
  ].join("\n");
}
```

- [ ] **Step 2: Register architectPrompt in ROLE_PROMPTS**

Change the `ROLE_PROMPTS` record:
```typescript
const ROLE_PROMPTS: Record<Role, (agent: string) => string> = {
  plan: planPrompt,
  implement: implementPrompt,
  review: reviewPrompt,
  refine: refinePrompt,
  fix: fixPrompt,
  final: finalPrompt,
  architect: architectPrompt,
};
```

- [ ] **Step 3: Update systemPromptFor to handle architect**

The `systemPromptFor` function (line 294) has a special case for ollama implement and plan. Architect needs no special case — it falls through to `ROLE_PROMPTS[role]`. Verify the function body:
```typescript
export function systemPromptFor(role: Role, agent: string, fanOut = false): string {
  if (role === "implement" && getModel(agent)?.kind === "ollama-http") return ollamaImplementPrompt(agent);
  if (role === "plan") return planPrompt(agent, fanOut);
  const fn = ROLE_PROMPTS[role];
  if (!fn) throw new Error(`No system prompt for role: ${role}`);
  return fn(agent);
}
```
No change needed — `architect` is in `ROLE_PROMPTS` now and falls through correctly.

- [ ] **Step 4: Add projectContext parameter to buildWorkerPrompt**

Change `buildWorkerPrompt` (line 312) to accept and inject `projectContext`:
```typescript
export function buildWorkerPrompt(input: {
  role: Role;
  agent: string;
  /** Сохранён для совместимости; не используется построителем. */
  family?: string;
  /** Исходная задача пользователя (что надо сделать). */
  task: string;
  /** Вывод предыдущего шага (digest / review / plan), или null. */
  context: string | null;
  /** Пути, ограничивающие область работы. */
  targetPaths?: string[];
  /** true для воркфлоу с fan_out — plan обязан выдать строгий JSON SubtaskPlan. */
  fanOut?: boolean;
  /** Контекст проекта из директории знаний (секции 00-project/ + 05-context/). */
  projectContext?: string;
}): string {
  const system = systemPromptFor(input.role, input.agent, input.fanOut);
  const parts: string[] = [system, "", "---", ""];

  if (input.projectContext) {
    parts.push("PROJECT CONTEXT:", input.projectContext, "", "---", "");
  }

  if (input.targetPaths && input.targetPaths.length > 0) {
    parts.push(`TARGET_PATHS (work only in these): ${input.targetPaths.join(", ")}`, "");
  }

  if (input.context) {
    parts.push("CONTEXT (output from the previous step):", input.context, "");
  }

  parts.push("---", "TASK:", input.task);
  return parts.join("\n");
}
```

- [ ] **Step 5: Verify it compiles and architect prompt renders**

Run:
```bash
npx tsx --eval "
import('./src/prompts/roles.ts').then(m => {
  const p = m.buildWorkerPrompt({ role: 'architect', agent: 'claude', task: 'scan', context: null });
  console.log(p.slice(0, 200));
  console.log('---');
  const p2 = m.buildWorkerPrompt({ role: 'implement', agent: 'glm', task: 'do', context: null, projectContext: 'ARCH: x\\nCODE: y' });
  console.log(p2.includes('PROJECT CONTEXT:') ? 'injection OK' : 'MISSING');
})
"
```
Expected: architect prompt starts with "You are Claude", contains "ROLE: ARCHITECT"; second call prints "injection OK".

- [ ] **Step 6: Commit**

```bash
git add src/prompts/roles.ts
git commit -m "feat(prompts): architect role + projectContext injection in buildWorkerPrompt"
```

---

## Task 6: Context cache + buildProjectContext

**Files:**
- Create: `src/project-knowledge/context.ts`

**Interfaces:**
- Consumes: `Role` from `../envelope.ts`, `knowledgeDirFor` from `./registry.ts`.
- Produces: `loadProjectContextCache(slug)` → `Map<string, string>`; `buildProjectContext(role, cache, activeTask)` → `string | null`.

- [ ] **Step 1: Create the context module**

```typescript
// src/project-knowledge/context.ts
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { knowledgeDirFor } from "./registry.ts";
import type { Role } from "../envelope.ts";

/**
 * Файлы, которые могут понадобиться инъекции (union по всем ролям).
 * Читаются один раз в начале runWorkflow — immutable кэш на прогон.
 * active-task сюда НЕ входит (он — переменная в runWorkflow).
 */
const CACHE_FILES = [
  "00-project/product.md",
  "00-project/architecture.md",
  "00-project/code-map.md",
  "00-project/glossary.md",
  "00-project/stack-rules.md",
  "05-context/file-allowlist.md",
  "05-context/file-blocklist.md",
  "05-context/naming-rules.md",
  "05-context/done-definition.md",
];

export type ContextCache = Map<string, string>;

/**
 * Прочитать все файлы контекста в кэш (один раз за прогон).
 * Пропускает отсутствующие. Возвращает пустой Map если директории нет.
 */
export async function loadProjectContextCache(slug: string): Promise<ContextCache> {
  const cache: ContextCache = new Map();
  const dir = knowledgeDirFor(slug);
  if (!existsSync(dir)) return cache;
  for (const rel of CACHE_FILES) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    try {
      const content = await readFile(abs, "utf8");
      // Пропускаем пустые/только-заглушки: если контент < 10 символов или
      // состоит только из комментария/`(none yet)` — не инъектируем.
      const trimmed = content.trim();
      if (trimmed.length < 10) continue;
      if (/^\(none yet\)$/.test(trimmed)) continue;
      cache.set(rel, content);
    } catch {
      // файл пропал между existsSync и readFile — пропускаем
    }
  }
  return cache;
}

/**
 * Секции для каждой роли в порядке приоритета.
 * active-task отмечен как "$ACTIVE_TASK" — подставляется из переменной, не из кэша.
 */
const ROLE_SECTIONS: Record<Role, string[]> = {
  plan: [
    "00-project/architecture.md",
    "00-project/code-map.md",
    "00-project/glossary.md",
    "$ACTIVE_TASK",
  ],
  implement: [
    "00-project/code-map.md",
    "00-project/stack-rules.md",
    "05-context/file-allowlist.md",
    "05-context/file-blocklist.md",
    "05-context/naming-rules.md",
  ],
  refine: [
    "00-project/code-map.md",
    "00-project/stack-rules.md",
    "05-context/file-allowlist.md",
    "05-context/file-blocklist.md",
    "05-context/naming-rules.md",
  ],
  fix: [
    "00-project/code-map.md",
    "00-project/stack-rules.md",
    "05-context/done-definition.md",
    "05-context/file-blocklist.md",
  ],
  review: [
    "00-project/code-map.md",
    "05-context/done-definition.md",
    "05-context/file-allowlist.md",
  ],
  final: [
    "$ACTIVE_TASK",
    "05-context/done-definition.md",
  ],
  architect: [],
};

const MAX_CONTEXT_CHARS = 6000;

/**
 * Обрезать текст по границе: сначала \n\n (абзац), потом \n (строка),
 * потом по символу. Возвращает обрезанный текст + маркер усечения.
 */
function truncateAt(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // 1. Граница абзаца (\n\n)
  let cut = text.lastIndexOf("\n\n", maxLen);
  if (cut > maxLen * 0.5) return text.slice(0, cut) + "\n…[truncated]";
  // 2. Граница строки (\n)
  cut = text.lastIndexOf("\n", maxLen);
  if (cut > maxLen * 0.5) return text.slice(0, cut) + "\n…[truncated]";
  // 3. По символу
  return text.slice(0, maxLen) + "…[truncated]";
}

/**
 * Собрать контекст проекта для роли из кэша + activeTask.
 * Чистая функция над данными в памяти (не читает диск).
 * Возвращает null если контекста нет (деградация).
 */
export function buildProjectContext(
  role: Role,
  cache: ContextCache,
  activeTask: string | null,
): string | null {
  const sections = ROLE_SECTIONS[role];
  if (sections.length === 0) return null; // architect — не инъектируется

  const parts: string[] = [];
  let used = 0;
  for (const rel of sections) {
    let content: string | null = null;
    let label: string;
    if (rel === "$ACTIVE_TASK") {
      if (!activeTask) continue;
      content = activeTask;
      label = "active-task";
    } else {
      content = cache.get(rel) ?? null;
      if (!content) continue;
      label = rel;
    }
    const available = MAX_CONTEXT_CHARS - used;
    if (available <= 0) break;
    // Заголовок секции + контент
    const header = `### ${label}\n`;
    if (header.length + content.length <= available) {
      // Влезает целиком
      parts.push(header + content);
      used += header.length + content.length + 2; // +2 для \n\n
    } else {
      // Не влезает целиком — обрезаем по границе. Если после обрезки
      // остаётся < 100 символов — drop whole (не добавляем обрубок).
      const spaceForContent = available - header.length - 2;
      if (spaceForContent < 100) break; // drop whole, и остальные тоже
      const truncated = truncateAt(content, spaceForContent);
      parts.push(header + truncated);
      used = MAX_CONTEXT_CHARS; // бюджет исчерпан
      break;
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
```

- [ ] **Step 2: Verify buildProjectContext with a mock cache**

Run:
```bash
npx tsx --eval "
import('./src/project-knowledge/context.ts').then(m => {
  const cache = new Map([
    ['00-project/code-map.md', 'main.ts → entry\\nsrc/ → modules\\n'.repeat(50)],
    ['00-project/stack-rules.md', 'Use TS, ESM\\n'],
  ]);
  const ctx = m.buildProjectContext('implement', cache, null);
  console.log(ctx ? ctx.slice(0, 100) : 'null');
  console.log('---architect (should be null):');
  console.log(m.buildProjectContext('architect', cache, null));
})
"
```
Expected: prints code-map content for implement role; `null` for architect.

- [ ] **Step 3: Commit**

```bash
git add src/project-knowledge/context.ts
git commit -m "feat(project-knowledge): context cache + role-based buildProjectContext"
```

---

## Task 7: Architect result parsing + file writing

**Files:**
- Create: `src/project-knowledge/architect.ts`

**Interfaces:**
- Consumes: `WorkerResult.output` (string, possibly JSON-in-fence), `knowledgeDirFor` from `./registry.ts`.
- Produces: `parseArchitectJson(output)` → `{ product, architecture, code_map, glossary, stack_rules } | null`; `writeProjectFiles(slug, parsed)` → void; `scanProjectStructure(projectPath)` → string (for architect context).

- [ ] **Step 1: Create the architect module**

```typescript
// src/project-knowledge/architect.ts
import { writeFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { knowledgeDirFor } from "./registry.ts";

/** Ожидаемые ключи JSON-вывода архитектора → имя файла. */
const KEY_TO_FILE: Record<string, string> = {
  product: "00-project/product.md",
  architecture: "00-project/architecture.md",
  code_map: "00-project/code-map.md",
  glossary: "00-project/glossary.md",
  stack_rules: "00-project/stack-rules.md",
};

export interface ArchitectResult {
  product: string;
  architecture: string;
  code_map: string;
  glossary: string;
  stack_rules: string;
}

/**
 * Распарсить вывод архитектора в структуру.
 * Переваривает: голый JSON, JSON в ```json fence, лишний текст вокруг.
 * Возвращает null если JSON невалиден или нет ни одного ожидаемого ключа.
 */
export function parseArchitectJson(output: string): ArchitectResult | null {
  // 1. Попытка вытащить JSON из fence ```json ... ```
  let jsonStr: string | null = null;
  const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  } else {
    // 2. Попытка найти первый { и последний } (голый JSON, возможно с текстом вокруг)
    const firstBrace = output.indexOf("{");
    const lastBrace = output.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = output.slice(firstBrace, lastBrace + 1);
    }
  }
  if (!jsonStr) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  // Проверяем, что есть хотя бы один ожидаемый ключ.
  const result: Partial<ArchitectResult> = {};
  let found = 0;
  for (const [key, file] of Object.entries(KEY_TO_FILE)) {
    const val = parsed[key];
    if (typeof val === "string" && val.trim().length > 0) {
      (result as Record<string, string>)[key] = val;
      found++;
    }
  }
  if (found === 0) return null;
  // Заполняем отсутствующие ключи заглушкой
  for (const key of Object.keys(KEY_TO_FILE)) {
    if (!(key in result)) {
      (result as Record<string, string>)[key] = `<!-- ${key}: not generated by architect -->`;
    }
  }
  return result as ArchitectResult;
}

/**
 * Записать распарсенный результат архитектора в 00-project/*.md.
 */
export async function writeProjectFiles(slug: string, parsed: ArchitectResult): Promise<void> {
  const dir = knowledgeDirFor(slug);
  const projectDir = join(dir, "00-project");
  await mkdir(projectDir, { recursive: true });
  for (const [key, file] of Object.entries(KEY_TO_FILE)) {
    const content = (parsed as Record<string, string>)[key];
    await writeFile(join(dir, file), content, "utf8");
  }
}

/**
 * Просканировать структуру проекта для контекста архитектора.
 * Возвращает строку с ls корня, package.json/README (если есть), tree -L 2.
 * Это единственная роль, где context = live-скан, а не директория знаний.
 */
export async function scanProjectStructure(projectPath: string): Promise<string> {
  const parts: string[] = [];

  // 1. Listing корня
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    const listing = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => `${e.isDirectory() ? "[D]" : "[F]"} ${e.name}`)
      .join("\n");
    parts.push(`ROOT LISTING:\n${listing}`);
  } catch {
    parts.push("ROOT LISTING: (unable to read)");
  }

  // 2. package.json (если есть)
  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      parts.push(
        `PACKAGE.JSON:\n${JSON.stringify({
          name: pkg.name,
          version: pkg.version,
          type: pkg.type,
          scripts: pkg.scripts,
          dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
          devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : [],
        }, null, 2)}`,
      );
    } catch {
      parts.push("PACKAGE.JSON: (unparseable)");
    }
  }

  // 3. README (первые 2000 символов)
  for (const readmeName of ["README.md", "README.txt", "README"]) {
    const readmePath = join(projectPath, readmeName);
    if (existsSync(readmePath)) {
      try {
        const content = await readFile(readmePath, "utf8");
        parts.push(`README (${readmeName}):\n${content.slice(0, 2000)}`);
      } catch {
        // skip
      }
      break;
    }
  }

  // 4. Дерево поддиректорий (глубина 2, без node_modules/.git)
  try {
    const tree = await buildTree(projectPath, "", 2);
    parts.push(`DIRECTORY TREE:\n${tree}`);
  } catch {
    parts.push("DIRECTORY TREE: (unable to build)");
  }

  return parts.join("\n\n---\n\n");
}

/** Рекурсивно построить дерево директорий (до maxDepth), исключая шум. */
async function buildTree(dir: string, prefix: string, maxDepth: number): Promise<string> {
  if (maxDepth <= 0) return "";
  const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".orchestrator", "__pycache__"]);
  let result = "";
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const visible = entries
      .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const e of visible) {
      result += `${prefix}${e.isDirectory() ? "[" + e.name + "]" : e.name}\n`;
      if (e.isDirectory()) {
        result += await buildTree(join(dir, e.name), prefix + "  ", maxDepth - 1);
      }
    }
  } catch {
    // permission denied etc
  }
  return result;
}
```

- [ ] **Step 2: Verify parsing handles fence and bare JSON**

Run:
```bash
npx tsx --eval "
import('./src/project-knowledge/architect.ts').then(m => {
  const fenced = '\`\`\`json\n{\"product\":\"x\",\"architecture\":\"y\",\"code_map\":\"c\",\"glossary\":\"g\",\"stack_rules\":\"s\"}\n\`\`\`';
  console.log('fenced:', !!m.parseArchitectJson(fenced));
  const bare = 'Here is the result: {\"product\":\"x\",\"architecture\":\"y\",\"code_map\":\"c\",\"glossary\":\"g\",\"stack_rules\":\"s\"} done.';
  console.log('bare:', !!m.parseArchitectJson(bare));
  const bad = 'not json at all';
  console.log('bad:', m.parseArchitectJson(bad));
  const partial = '{\"product\":\"x\",\"architecture\":\"y\"}';
  const r = m.parseArchitectJson(partial);
  console.log('partial found:', r?.product, 'missing filled:', r?.code_map?.includes('not generated'));
})
"
```
Expected: `fenced: true`, `bare: true`, `bad: null`, partial found with `x` and code_map contains "not generated".

- [ ] **Step 3: Commit**

```bash
git add src/project-knowledge/architect.ts
git commit -m "feat(project-knowledge): architect JSON parsing + project scanning"
```

---

## Task 8: project-init workflow YAML

**Files:**
- Create: `workflows/project-init.yaml`

**Interfaces:**
- Consumes: `WorkflowSchema` (validates the YAML).
- Produces: a workflow named `project-init` with one `architect` step.

- [ ] **Step 1: Create the workflow file**

```yaml
# workflows/project-init.yaml
name: project-init
description: |
  Генерация контекста проекта (00-project/*.md) ролью architect.
  Запускается при открытии проекта через UI (кнопка «Открыть проект»).
steps:
  - id: discover
    agent: claude
    role: architect
    effort: high
    budget:
      wall_time_sec: 300
      max_steps: 1
      max_session_min: 5
    depends_on: []
    target_paths: []
```

- [ ] **Step 2: Verify it loads and validates**

Run:
```bash
npx tsx --eval "
import('./src/workflow.ts').then(async (m) => {
  const fs = await import('node:fs/promises');
  const yaml = (await import('yaml')).parse;
  const raw = await fs.readFile('./workflows/project-init.yaml', 'utf8');
  const wf = m.WorkflowSchema.parse(yaml(raw));
  console.log('loaded:', wf.name, 'steps:', wf.steps.length, 'role:', wf.steps[0].role);
})
"
```
Expected: `loaded: project-init steps: 1 role: architect`

- [ ] **Step 3: Commit**

```bash
git add workflows/project-init.yaml
git commit -m "feat(workflow): project-init workflow for architect role"
```

---

## Task 9: Wire ctxCache/activeTask into runner (injection point)

**Files:**
- Modify: `src/runner.ts` — `runWorkflow`, `runWorkerOnly`, `runStep`, `runFanOut`.

**Interfaces:**
- Consumes: `slugFromPath` from `./project-knowledge/slug.ts`, `loadProjectContextCache`/`buildProjectContext` from `./project-knowledge/context.ts`, `Role` from `./envelope.ts`.
- Produces: `runWorkflow` loads ctxCache + activeTask, passes through `WorkerOnlyOpts`; `runWorkerOnly` calls `buildProjectContext` before `buildWorkerPrompt`.

- [ ] **Step 1: Add ctxCache/activeTask to WorkerOnlyOpts**

In `src/runner.ts`, find `interface WorkerOnlyOpts` (around line 163) and add fields:
```typescript
interface WorkerOnlyOpts {
  iteration?: number;
  subtaskSuffix?: string;
  cwdOverride?: string;
  skipWorktree?: boolean;
  fanOut?: boolean;
  contextOverride?: string | null;
  /** Кэш контекста проекта (immutable, загружается один раз в runWorkflow). */
  ctxCache?: Map<string, string>;
  /** Текущий active-task (строка markdown, из переменной в runWorkflow). */
  activeTask?: string | null;
}
```

- [ ] **Step 2: Inject projectContext in runWorkerOnly before buildWorkerPrompt**

In `runWorkerOnly` (around line 241), change the `buildWorkerPrompt` call to compute `projectContext` first:
```typescript
  const fanOutPlan = o.fanOut ?? (step.role === "plan" && allSteps.some((s) => s.fan_out && s.from_plan === step.id));
  // Инъекция контекста проекта (для architect — null, он получает live-скан).
  const projectContext = o.ctxCache
    ? buildProjectContext(step.role, o.ctxCache, o.activeTask ?? null)
    : null;
  const fullPrompt = buildWorkerPrompt({
    role: step.role,
    agent: step.agentName,
    family: step.family,
    task: prompt,
    context,
    targetPaths: step.target_paths,
    fanOut: fanOutPlan,
    projectContext: projectContext ?? undefined,
  });
```

Add imports at the top of `src/runner.ts`:
```typescript
import { slugFromPath } from "./project-knowledge/slug.ts";
import { loadProjectContextCache, buildProjectContext } from "./project-knowledge/context.ts";
```

- [ ] **Step 3: Load ctxCache + activeTask in runWorkflow**

In `runWorkflow` (around line 827, after `const projectPath = opts.project;`), add:
```typescript
  // ─── Контекст проекта: загрузить кэш один раз (immutable на прогон) ───
  const slug = slugFromPath(projectPath);
  let ctxCache: Map<string, string>;
  try {
    ctxCache = await loadProjectContextCache(slug);
  } catch (e) {
    await logEvent({
      task_id: "—", step_id: null, level: "warn",
      kind: "project_context_load_failed",
      message: `Failed to load project context for slug '${slug}': ${e instanceof Error ? e.message : String(e)}`,
    });
    ctxCache = new Map();
  }
  // active-task: переменная в scope runWorkflow (не дисковое чтение).
  // Формируется на старте, обновляется после plan-шага, архивируется при завершении.
  let activeTask: string | null = null;
  let baseSha: string | null = null;
```

- [ ] **Step 4: Form activeTask + capture baseSha after createTask**

After `const task = await createTask(...)` (around line 871), add:
```typescript
  // ─── active-task: формируем из prompt, пишем на диск для персистентности ───
  const now = new Date().toISOString();
  activeTask = [
    "# Active Task",
    `status: in_progress`,
    `updated: ${now}`,
    "",
    "## Goal",
    opts.prompt,
    "",
    "## Scope",
    `- target_paths: ${opts.project}`,
    "",
    "## Acceptance Criteria",
    "(pending plan step)",
    "",
    "## Notes",
    "",
  ].join("\n");
  // baseSha: снимаем ДО создания worktree/integration-ветки (иначе он уже
  // будет содержать изменения). Нужен для touched-files при архивации.
  try {
    const { stdout } = await git(projectPath, ["rev-parse", "HEAD"]);
    baseSha = stdout.trim();
  } catch {
    baseSha = null;
  }
```

- [ ] **Step 5: Pass ctxCache/activeTask through runStep calls**

`runStep` needs to accept and forward `ctxCache`/`activeTask`. Change the `runStep` signature (line 413) to add params:
```typescript
async function runStep(
  taskId: string,
  step: ResolvedStep,
  stepIdx: number,
  prompt: string,
  projectPath: string,
  integrationWtPath: string,
  breaker: CircuitBreaker,
  allSteps: ResolvedStep[],
  iteration = 1,
  contextOverride?: string | null,
  ctxCache?: Map<string, string>,
  activeTask?: string | null,
): Promise<StepRun> {
```
And in the `runWorkerOnly` call inside `runStep` (line 444), pass them:
```typescript
  const { result, stepId, output, wt } = await runWorkerOnly(
    taskId,
    step,
    stepIdx,
    prompt,
    projectPath,
    breaker,
    allSteps,
    { iteration, cwdOverride, contextOverride: ctx, ctxCache, activeTask },
  );
```

Now update ALL call sites of `runStep` in `runWorkflow` to pass `ctxCache, activeTask`. There are call sites in:
- preLevels loop (~line 906, 911)
- postFanOutLevels loop (~line 940)
- loop body (~line 982)
- postLevels loop (~line 1039)

For each, add `ctxCache, activeTask` as the last two arguments. Example for the preLevels parallel path:
```typescript
      const results = await runBounded(level, concurrency, (step) =>
        runStep(task.id, step, allSteps.indexOf(step), opts.prompt, projectPath, integrationWtPath, breaker, allSteps, 1, undefined, ctxCache, activeTask),
      );
```
And for sequential:
```typescript
        const r = await runStep(task.id, step, allSteps.indexOf(step), opts.prompt, projectPath, integrationWtPath, breaker, allSteps, 1, undefined, ctxCache, activeTask);
```

- [ ] **Step 6: Pass ctxCache/activeTask through runFanOut**

`runFanOut` (line 518) calls `runWorkerOnly` directly (lines 611, 694). Add `ctxCache`/`activeTask` params to `runFanOut` signature:
```typescript
async function runFanOut(
  taskId: string,
  spec: FanOutSpec,
  allSteps: ResolvedStep[],
  prompt: string,
  projectPath: string,
  integrationWtPath: string,
  breaker: CircuitBreaker,
  threshold: number,
  maxParallel: number,
  ctxCache?: Map<string, string>,
  activeTask?: string | null,
): Promise<FanOutOutcome> {
```
Then in the two `runWorkerOnly` calls inside `runFanOut`:
- Line 611 (implement): add `ctxCache, activeTask` to the options object:
```typescript
    const { result, stepId, wt } = await runWorkerOnly(
      taskId, implStep, stepIdx,
      `${subtask.goal}\n\nACCEPTANCE CRITERIA: ${subtask.acceptance_criteria}`,
      projectPath, breaker, allSteps,
      { subtaskSuffix: `~${subtask.id}`, ctxCache, activeTask },
    );
```
- Line 694 (review): add `ctxCache, activeTask`:
```typescript
    const rr = await runWorkerOnly(
      taskId, reviewStep, stepIdx, buildReviewPrompt(item.subtask),
      projectPath, breaker, allSteps,
      { subtaskSuffix: `~${item.subtask.id}r`, cwdOverride: candidate.worktreePath, skipWorktree: true, ctxCache, activeTask },
    );
```

Update the `runFanOut` call site in `runWorkflow` (line 926):
```typescript
      const fo = await runFanOut(
        task.id, spec, allSteps, opts.prompt, projectPath,
        integrationWtPath, breaker,
        threshold, effectiveMaxParallel,
        ctxCache, activeTask,
      );
```

- [ ] **Step 7: Verify the runner still compiles**

Run: `npx tsx --eval "import('./src/runner.ts').then(() => console.log('runner imports OK'))"`
Expected: `runner imports OK` (no type errors).

- [ ] **Step 8: Commit**

```bash
git add src/runner.ts
git commit -m "feat(runner): inject project context via ctxCache/activeTask in runWorkerOnly"
```

---

## Task 10: Archive task result to 07-output on completion

**Files:**
- Modify: `src/runner.ts` — add archive call before `return` in `runWorkflow`.

**Interfaces:**
- Consumes: `slugFromPath`, `knowledgeDirFor`, `baseSha`, `integrationBranch`, `git`, `updateProjectStatus` (not needed here, but `logEvent` for warnings).

- [ ] **Step 1: Create archive helper in project-knowledge module**

Add to `src/project-knowledge/architect.ts` (or a new `src/project-knowledge/archive.ts` — prefer a new file for separation):
```typescript
// src/project-knowledge/archive.ts
import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { knowledgeDirFor } from "./registry.ts";

/**
 * Архивировать завершённую задачу: дописать блок в decisions.md и touched-files.md.
 * touched-files считается через git diff --name-only <baseSha> <integrationTip>.
 * active-task сбрасывается в idle шаблон.
 */
export async function archiveTask(
  slug: string,
  taskId: string,
  prompt: string,
  success: boolean,
  baseSha: string | null,
  changedFiles: string[],
): Promise<void> {
  const dir = knowledgeDirFor(slug);
  if (!existsSync(dir)) return; // директории знаний нет — не архивируем

  const outputDir = join(dir, "07-output");
  await mkdir(outputDir, { recursive: true });
  const now = new Date().toISOString();
  const verdict = success ? "SUCCESS" : "FAILED";

  // decisions.md — append
  const decisionBlock = [
    "",
    `## ${taskId} — ${now} — ${verdict}`,
    `Prompt: ${prompt.slice(0, 200)}`,
    `Files changed: ${changedFiles.length}`,
    "",
  ].join("\n");
  await appendFile(join(outputDir, "decisions.md"), decisionBlock, "utf8");

  // touched-files.md — append
  const filesBlock = [
    "",
    `## ${taskId} — ${now}`,
    ...changedFiles.map((f) => `- ${f}`),
    "",
  ].join("\n");
  await appendFile(join(outputDir, "touched-files.md"), filesBlock, "utf8");

  // active-task.md — reset to idle
  const idleContent = [
    "# Active Task",
    "status: idle",
    `updated: ${now}`,
    "",
    "## Goal",
    "",
    "## Scope",
    "- target_paths: none",
    "",
    "## Acceptance Criteria",
    "",
    "## Notes",
    "",
  ].join("\n");
  await writeFile(join(dir, "03-tasks", "active-task.md"), idleContent, "utf8");
}
```

- [ ] **Step 2: Call archiveTask in runWorkflow before return**

In `src/runner.ts`, add import:
```typescript
import { archiveTask } from "./project-knowledge/archive.ts";
```

Before the final `return` in `runWorkflow` (around line 1064, after `await updateTask(task.id, { status: overallSuccess ? "done" : "escalated_hitl" });`), add:
```typescript
  // ─── Архивация в директорию знаний (07-output + active-task reset) ───
  // Diff: baseSha (снят ДО worktree) → tip integration-ветки. two-dot, не three-dot.
  let changedFiles: string[] = [];
  if (baseSha) {
    try {
      const { stdout } = await git(projectPath, ["diff", "--name-only", baseSha, integrationBranch(task.id)]);
      changedFiles = stdout.trim().split("\n").filter(Boolean);
    } catch {
      // integration-ветка может быть уже удалена (cleanup при провале) — логируем, не падаем.
      await logEvent({
        task_id: task.id, step_id: null, level: "warn",
        kind: "archive_diff_failed",
        message: `Could not compute touched-files diff for ${task.id} (baseSha=${baseSha.slice(0, 8)})`,
      });
    }
  }
  try {
    await archiveTask(slug, task.id, opts.prompt, overallSuccess, baseSha, changedFiles);
  } catch (e) {
    // Архивация — best-effort, не должна валить задачу.
    await logEvent({
      task_id: task.id, step_id: null, level: "warn",
      kind: "archive_failed",
      message: `archiveTask failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
```

- [ ] **Step 3: Verify runner still compiles**

Run: `npx tsx --eval "import('./src/runner.ts').then(() => console.log('runner imports OK'))"`
Expected: `runner imports OK`

- [ ] **Step 4: Commit**

```bash
git add src/project-knowledge/archive.ts src/runner.ts
git commit -m "feat(runner): archive task result to 07-output + reset active-task"
```

---

## Task 11: CLI --init-project flag

**Files:**
- Modify: `src/cli.ts` — add `--init-project` and `--project-slug` flags.

**Interfaces:**
- Consumes: `getOrCreateProject`, `updateProjectStatus`, `copySkeleton`, `runWorkflow`, `readResult`, `parseArchitectJson`, `writeProjectFiles`, `scanProjectStructure`.
- Produces: CLI mode that runs the architect workflow and post-processes the result into `00-project/*.md`.

- [ ] **Step 1: Add flags to parseArgs options**

In `src/cli.ts`, in the `parseArgs` options object (line 91), add:
```typescript
    "init-project": { type: "boolean", default: false },
    "project-slug": { type: "string" },
```

- [ ] **Step 2: Add the init-project branch**

After the `values.accept` block (line 152) and before `const prompt = positionals.join(" ")`, add:
```typescript
  if (values["init-project"]) {
    // ─── Режим инициализации директории знаний проекта ───
    // CLI сам вызывает getOrCreateProject (создаёт запись реестра с правильным slug,
    // включая коллизионный суффикс если нужно), затем запускает workflow project-init
    // (роль architect), парсит JSON-результат и пишет 00-project/*.md.
    // --project-slug опционален: если задан — используем его (regenerate случая),
    // иначе slug берём из getOrCreateProject.
    const { getOrCreateProject, updateProjectStatus, knowledgeDirFor } = await import("./project-knowledge/registry.ts");
    const { copySkeleton } = await import("./project-knowledge/skeleton.ts");
    const { scanProjectStructure, parseArchitectJson, writeProjectFiles } = await import("./project-knowledge/architect.ts");
    const { readResult: readResultBb } = await import("./blackboard.ts");
    const { existsSync: exists } = await import("node:fs");

    // 1. Создать/найти запись реестра → получить slug (с учётом коллизий).
    const explicitSlug = typeof values["project-slug"] === "string" ? values["project-slug"] : undefined;
    let slug: string;
    if (explicitSlug) {
      slug = explicitSlug;
    } else {
      const entry = await getOrCreateProject(project);
      slug = entry.slug;
    }

    // 2. Скопировать скелет (если ещё не скопирован).
    const knowledgeDir = knowledgeDirFor(slug);
    if (!exists(knowledgeDir)) {
      await copySkeleton(knowledgeDir);
    }

    // 3. Запустить workflow project-init.
    const initPrompt = "Analyze this project and generate the 00-project knowledge base files.";
    const workflowPath = join(WORKFLOWS_DIR, "project-init.yaml");
    if (!existsSync(workflowPath)) {
      console.error(`Workflow not found: ${workflowPath}`);
      process.exit(1);
    }
    console.log(`▶ init-project: slug=${slug}`);
    console.log(`▶ project:      ${project}`);

    const result = await runWorkflow({
      workflowPath,
      prompt: initPrompt,
      project,
    });

    if (!result.success) {
      await updateProjectStatus(slug, "failed", `architect workflow failed for task ${result.task.id}`);
      console.error(`\n✗ architect workflow failed. Task: ${result.task.id}`);
      process.exit(1);
    }

    // 4. Post-process: прочитать результат шага discover, распарсить JSON, писать файлы.
    // Шаг discover — единственный в project-init, его stepId = <taskId>-S01.
    const discoverStepId = `${result.task.id}-S01`;
    const raw = await readResultBb(result.task.id, discoverStepId);
    if (!raw || typeof raw !== "object" || !("output" in raw)) {
      await updateProjectStatus(slug, "failed", "architect result missing output");
      console.error(`✗ architect result has no output`);
      process.exit(1);
    }
    const output = String((raw as { output: string }).output);
    const parsed = parseArchitectJson(output);
    if (!parsed) {
      await updateProjectStatus(slug, "failed", `could not parse architect JSON from output (first 200 chars): ${output.slice(0, 200)}`);
      console.error(`✗ could not parse architect JSON`);
      console.error(`  output (first 500): ${output.slice(0, 500)}`);
      process.exit(1);
    }
    await writeProjectFiles(slug, parsed);
    await updateProjectStatus(slug, "ready");

    console.log(`\n✓ project knowledge generated for slug '${slug}'`);
    console.log(`  knowledge dir: ${knowledgeDir}`);
    console.log(`  files written: 00-project/{product,architecture,code-map,glossary,stack-rules}.md`);
    return;
  }
```

Note: no top-level import for `slugFromPath` needed — `getOrCreateProject` handles slug internally. The `--project-slug` flag is only used for the `regenerate` flow (Task 12) where the slug is already known.

- [ ] **Step 3: Verify --init-project flag is recognized**

Run: `npx tsx src/cli.ts --help`
Expected: usage text (the `--init-project` flag isn't in usage text yet, but it's accepted by parseArgs due to `strict: false`).

- [ ] **Step 4: Add --init-project to usage text**

In the `usage()` function in `src/cli.ts`, add to OPTIONS:
``    "  --init-project          initialize project knowledge directory (architect role)",``
And `--project-slug <slug>`:
``    "  --project-slug <slug>   explicit slug for the project (used with --init-project)",``

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): --init-project flag for project knowledge generation"
```

---

## Task 12: Backend ProjectsService + ProjectsController

**Files:**
- Create: `ui-backend/src/projects.service.ts`
- Create: `ui-backend/src/projects.controller.ts`
- Modify: `ui-backend/src/app.module.ts`

**Interfaces:**
- Consumes: `ProcessManager` (for spawning architect), `validateProjectPath`.
- Produces: REST API `POST /projects/open`, `GET /projects`, `GET /projects/:slug`, `POST /projects/:slug/regenerate`.

- [ ] **Step 1: Create ProjectsService**

```typescript
// ui-backend/src/projects.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { ProcessManager } from "./process-manager.service";
import { validateProjectPath, validationMessage } from "./path-utils";

export interface ProjectDto {
  slug: string;
  projectPath: string;
  status: "ready" | "generating" | "failed";
  knowledgeDir: string;
  lastError?: string;
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(private readonly processManager: ProcessManager) {}

  /**
   * Открыть проект: валидация пути → запуск CLI --init-project (который сам
   * вызывает getOrCreateProject, создаёт скелет, запускает architect, пишет
   * 00-project/*.md, обновляет статус в реестре) → чтение результата из реестра.
   *
   * ui-backend не импортирует engine напрямую (по существующей архитектуре) —
   * взаимодействие через subprocess CLI. slug определяется внутри CLI
   * (getOrCreateProject с учётом коллизий), backend не дублирует slug-логику.
   */
  async open(projectPath: string): Promise<{ project: ProjectDto; clientKey: string | null }> {
    const v = validateProjectPath(projectPath);
    if (!v.ok) {
      throw new Error(validationMessage(v));
    }
    const absPath = v.path;

    // runOnce: запускает CLI и ждёт завершения (без SSE-стрима).
    // UI показывает "generating..." и опрашивает GET /projects/:slug для статуса.
    const result = await this.processManager.runOnce([
      "--project", absPath,
      "--init-project",
    ]);

    if (!result.ok) {
      this.logger.error(`init-project failed: ${result.output.slice(-500)}`);
      throw new Error(`project init failed: ${result.output.slice(-500)}`);
    }

    // CLI уже записал ready/failed в реестр. Читаем запись по projectPath.
    const project = await this.readFromRegistry(absPath);
    return { project, clientKey: null };
  }

  /** Прочитать запись из registry.json (дублирует чтение engine, но без импорта engine). */
  private async readFromRegistry(projectPath: string): Promise<ProjectDto> {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const registryFile = join(homedir(), ".orchestrator", "projects.json");
    if (!existsSync(registryFile)) {
      throw new Error("projects registry not found");
    }
    const raw = await readFile(registryFile, "utf8");
    const reg = JSON.parse(raw) as { projects: ProjectDto[] };
    const entry = reg.projects.find((p) => p.projectPath === projectPath);
    if (!entry) throw new Error(`project not in registry: ${projectPath}`);
    return entry;
  }

  async list(): Promise<ProjectDto[]> {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const registryFile = join(homedir(), ".orchestrator", "projects.json");
    if (!existsSync(registryFile)) return [];
    const raw = await readFile(registryFile, "utf8");
    const reg = JSON.parse(raw) as { projects: ProjectDto[] };
    return reg.projects;
  }

  async getBySlug(slug: string): Promise<ProjectDto> {
    const all = await this.list();
    const entry = all.find((p) => p.slug === slug);
    if (!entry) throw new Error(`project slug not found: ${slug}`);
    return entry;
  }

  async regenerate(slug: string): Promise<{ project: ProjectDto }> {
    const entry = await this.getBySlug(slug);
    const result = await this.processManager.runOnce([
      "--project", entry.projectPath,
      "--init-project",
      "--project-slug", slug,
    ]);
    if (!result.ok) {
      throw new Error(`regenerate failed: ${result.output.slice(-500)}`);
    }
    const project = await this.readFromRegistry(entry.projectPath);
    return { project };
  }
}
```

- [ ] **Step 2: Create ProjectsController**

```typescript
// ui-backend/src/projects.controller.ts
import {
  Controller, Get, Post, Body, Param,
  BadRequestException, NotFoundException, InternalServerErrorException,
} from "@nestjs/common";
import { ProjectsService } from "./projects.service";

interface OpenBody {
  projectPath: string;
}

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list() {
    return this.projects.list();
  }

  @Get(":slug")
  async getBySlug(@Param("slug") slug: string) {
    try {
      return await this.projects.getBySlug(slug);
    } catch (e) {
      throw new NotFoundException((e as Error).message);
    }
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
      if (msg.includes("не существует") || msg.includes("не git")) {
        throw new BadRequestException(msg);
      }
      throw new InternalServerErrorException(msg);
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
```

Note: `@Post("open")` is declared BEFORE `@Get(":slug")` — but `POST` and `GET` are different verbs, so no route collision. The static `open` path is fine.

- [ ] **Step 3: Register in app.module.ts**

In `ui-backend/src/app.module.ts`:
```typescript
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";

@Module({
  controllers: [WorkflowsController, TasksController, ProcessesController, ModelsController, ProjectsController],
  providers: [BlackboardReader, ProcessManager, ModelsService, ProjectsService],
})
```

- [ ] **Step 4: Verify backend compiles**

Run:
```bash
cd ui-backend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors (or only pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add ui-backend/src/projects.service.ts ui-backend/src/projects.controller.ts ui-backend/src/app.module.ts
git commit -m "feat(backend): projects API (open/list/get/regenerate)"
```

---

## Task 13: UI — api client + entities for projects

**Files:**
- Modify: `ui-web/src/shared/api/index.ts` — add project methods.
- Create: `ui-web/src/entities/project/index.ts` — ProjectDto type.

**Interfaces:**
- Produces: `api.openProject`, `api.getProject`, `api.listProjects`; `ProjectDto` type.

- [ ] **Step 1: Create project entity**

```typescript
// ui-web/src/entities/project/index.ts
export type ProjectStatus = "ready" | "generating" | "failed";

export interface ProjectDto {
  slug: string;
  projectPath: string;
  status: ProjectStatus;
  knowledgeDir: string;
  lastError?: string;
}

export interface OpenProjectResponse {
  project: ProjectDto;
  clientKey: string | null;
}
```

- [ ] **Step 2: Export from entities barrel**

In `ui-web/src/entities/index.ts`, add:
```typescript
export * from "./project";
```

- [ ] **Step 3: Add api methods**

In `ui-web/src/shared/api/index.ts`, add to the `api` object (after `streamUrl`):
```typescript
  openProject: (projectPath: string) =>
    json<{ project: ProjectDto; clientKey: string | null }>(`/projects/open`, {
      method: "POST",
      body: JSON.stringify({ projectPath }),
    }),

  getProject: (slug: string) =>
    json<ProjectDto>(`/projects/${encodeURIComponent(slug)}`),

  listProjects: () =>
    json<ProjectDto[]>(`/projects`),
```
Also update the import at the top:
```typescript
import type { ModelDto, TaskRecord, WorkflowDto, ProjectDto } from "@/entities";
```

- [ ] **Step 4: Commit**

```bash
git add ui-web/src/entities/project/index.ts ui-web/src/entities/index.ts ui-web/src/shared/api/index.ts
git commit -m "feat(ui): project entity + api client methods"
```

---

## Task 14: UI — "Открыть проект" button in RunForm

**Files:**
- Modify: `ui-web/src/widgets/run-form/RunForm.tsx`

**Interfaces:**
- Consumes: `api.openProject`, `api.getProject`, `ProjectDto`, `ProjectStatus` from entities.

- [ ] **Step 1: Add project state and open handler to RunForm**

In `ui-web/src/widgets/run-form/RunForm.tsx`, add state and imports. Change the component:

Add imports:
```typescript
import type { ProjectDto } from "@/entities";
```

Add state inside the component (after `const [error, setError] = ...`):
```typescript
  const [projectInfo, setProjectInfo] = useState<ProjectDto | null>(null);
  const [opening, setOpening] = useState(false);
```

Add handler:
```typescript
  async function openProject() {
    if (!project.trim()) return;
    setOpening(true);
    setError(null);
    try {
      const res = await api.openProject(project.trim());
      setProjectInfo(res.project);
    } catch (e) {
      setError((e as Error).message);
      setProjectInfo(null);
    } finally {
      setOpening(false);
    }
  }
```

- [ ] **Step 2: Add the button + status indicator to the UI**

In the JSX, after the project `<input>` (inside the same `<label>` or right after it), add a button and status. Replace the project field block (lines 71-80) with:
```tsx
        <label style={styles.field}>
          <span style={styles.label}>Проект (путь к git-репозиторию)</span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="/Users/ilyalebedev/Desktop/iva-gang/numbers"
              value={project}
              onChange={(e) => { setProject(e.target.value); setProjectInfo(null); }}
              style={{ ...styles.input, flex: 1 }}
              disabled={disabled}
            />
            <button
              onClick={openProject}
              disabled={disabled || opening || !project.trim()}
              style={{
                ...styles.button,
                background: "#a6e3a1",
                ...(disabled || opening || !project.trim() ? styles.buttonDisabled : {}),
                whiteSpace: "nowrap" as const,
              }}
            >
              {opening ? "Открытие…" : "Открыть"}
            </button>
          </div>
        </label>
```

Add status indicator below the row (after the `</div>` that closes `styles.row`, before the hint):
```tsx
      {projectInfo && (
        <div style={{ marginTop: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <span>{projectInfo.status === "ready" ? "🟢" : projectInfo.status === "generating" ? "🟡" : "🔴"}</span>
          <span style={{ color: "#a6adc8" }}>
            {projectInfo.slug} ({projectInfo.status})
          </span>
          {projectInfo.status === "failed" && projectInfo.lastError && (
            <span style={{ color: "#f38ba8", fontSize: 12 }}>— {projectInfo.lastError}</span>
          )}
        </div>
      )}
```

- [ ] **Step 3: Verify the frontend compiles**

Run:
```bash
cd ui-web && npx tsc --noEmit 2>&1 | head -20
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add ui-web/src/widgets/run-form/RunForm.tsx
git commit -m "feat(ui): 'Открыть проект' button + status indicator in RunForm"
```

---

## Task 15: Smoke test for project-init

**Files:**
- Create: `scripts/smoke-project-init.ts`

**Interfaces:**
- Consumes: `getOrCreateProject`, `copySkeleton`, `slugFromPath`, `scanProjectStructure`, `parseArchitectJson`.

- [ ] **Step 1: Create the smoke test**

```typescript
// scripts/smoke-project-init.ts
/**
 * Smoke-тест: проверяет создание скелета директории знаний + парсинг architect JSON.
 * Не запускает реальную модель (для этого нужен --init-project на реальном проекте).
 * Проверяет: slug, registry, skeleton copy, parseArchitectJson.
 */
import { getOrCreateProject, updateProjectStatus, findProject } from "../src/project-knowledge/registry.ts";
import { copySkeleton } from "../src/project-knowledge/skeleton.ts";
import { slugFromPath } from "../src/project-knowledge/slug.ts";
import { parseArchitectJson, writeProjectFiles, scanProjectStructure } from "../src/project-knowledge/architect.ts";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

async function main(): Promise<void> {
  const testPath = "/tmp/smoke-test-project";
  console.log("=== smoke-project-init ===\n");

  // 1. Slug
  const slug = slugFromPath(testPath);
  console.log(`1. slug: ${slug}`);
  if (slug !== "smoke-test-project") throw new Error(`slug mismatch: ${slug}`);

  // 2. Registry
  const entry = await getOrCreateProject(testPath);
  console.log(`2. registry entry: slug=${entry.slug} status=${entry.status}`);
  if (entry.status !== "generating") throw new Error(`expected generating, got ${entry.status}`);

  // 3. Skeleton
  await copySkeleton(entry.knowledgeDir);
  const hasActive = existsSync(join(entry.knowledgeDir, "03-tasks", "active-task.md"));
  const hasAllowlist = existsSync(join(entry.knowledgeDir, "05-context", "file-allowlist.md"));
  console.log(`3. skeleton: active-task=${hasActive} allowlist=${hasAllowlist}`);
  if (!hasActive || !hasAllowlist) throw new Error("skeleton files missing");

  // 4. parseArchitectJson
  const mockOutput = '```json\n{"product":"test","architecture":"arch","code_map":"map","glossary":"gloss","stack_rules":"rules"}\n```';
  const parsed = parseArchitectJson(mockOutput);
  console.log(`4. parseArchitectJson: product=${parsed?.product}`);
  if (!parsed || parsed.product !== "test") throw new Error("parse failed");

  // 5. writeProjectFiles
  await writeProjectFiles(entry.slug, parsed);
  const hasArch = existsSync(join(entry.knowledgeDir, "00-project", "architecture.md"));
  console.log(`5. writeProjectFiles: architecture.md=${hasArch}`);
  if (!hasArch) throw new Error("writeProjectFiles failed");

  // 6. scanProjectStructure (on orchestrator root itself)
  const scan = await scanProjectStructure(process.cwd());
  console.log(`6. scanProjectStructure: ${scan.length} chars (contains PACKAGE.JSON: ${scan.includes("PACKAGE.JSON")})`);
  if (!scan.includes("PACKAGE.JSON")) throw new Error("scan missed package.json");

  // 7. Status update
  await updateProjectStatus(entry.slug, "ready");
  const updated = await findProject(entry.slug);
  console.log(`7. status update: ${updated?.status}`);
  if (updated?.status !== "ready") throw new Error("status update failed");

  // Cleanup
  await rm(entry.knowledgeDir, { recursive: true, force: true });
  // Remove from registry (manual cleanup for test)
  const { readFile, writeFile } = await import("node:fs/promises");
  const regFile = join(homedir(), ".orchestrator", "projects.json");
  const reg = JSON.parse(await readFile(regFile, "utf8"));
  reg.projects = reg.projects.filter((p: { slug: string }) => p.slug !== entry.slug);
  await writeFile(regFile, JSON.stringify(reg, null, 2));

  console.log("\n✓ all smoke checks passed");
}

main().catch((e) => {
  console.error("✗ smoke failed:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke test**

Run: `npx tsx scripts/smoke-project-init.ts`
Expected: `✓ all smoke checks passed`

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-project-init.ts
git commit -m "test: smoke test for project knowledge init flow"
```

---

## Task 16: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Verify backend starts and projects endpoint responds**

Run in one terminal:
```bash
cd ui-backend && npx tsx watch src/main.ts
```
In another:
```bash
curl -s http://localhost:3001/projects | head -5
```
Expected: `[]` or a JSON array (empty if no projects yet).

- [ ] **Step 2: Verify open endpoint creates a project (dry run)**

```bash
curl -s -X POST http://localhost:3001/projects/open \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/Users/ilyalebedev/Desktop/iva-gang/z-cc-orchestrator"}' | head -20
```
Expected: JSON with `project` containing slug `z-cc-orchestrator`, status `ready` or `failed` (if architect model unavailable). This runs the real architect — may take a few minutes.

- [ ] **Step 3: Verify knowledge directory was created**

```bash
ls ~/.orchestrator/projects/z-cc-orchestrator/00-project/
```
Expected: `architecture.md code-map.md glossary.md product.md stack-rules.md` (if architect succeeded).

- [ ] **Step 4: Verify degradation — run a task on a project WITHOUT knowledge dir**

Run a workflow on a project that has no knowledge dir (e.g. a fresh temp git repo). The task should complete without errors (projectContext = null, graceful degradation).

- [ ] **Step 5: Final commit (if any fixes were needed)**

If verification surfaced issues, fix and commit them. Otherwise, no commit needed.

---

## Summary

This plan implements the project knowledge directory + context injection feature in 16 tasks:

1. **Slug utility** — path → slug conversion
2. **Registry** — `projects.json` CRUD with mutex
3. **Templates** — static skeleton files
4. **Role extension** — `architect` as 7th role across engine + UI
5. **Prompt + injection** — `architectPrompt` + `projectContext` param
6. **Context cache** — immutable per-run cache + role-based selection
7. **Architect parsing** — JSON extraction + project scanning
8. **Workflow YAML** — `project-init.yaml`
9. **Runner wiring** — ctxCache/activeTask through `runWorkflow` → `runWorkerOnly`
10. **Archiving** — `07-output` logs + active-task reset on completion
11. **CLI flag** — `--init-project` with post-processing
12. **Backend API** — `ProjectsController`/`ProjectsService`
13. **UI entities** — `ProjectDto` type + api methods
14. **UI button** — "Открыть проект" in RunForm
15. **Smoke test** — unit-level verification of the init flow
16. **E2E verification** — manual check of the full flow
