# Project Knowledge Directory & Context Injection — Design

**Дата:** 2026-07-11
**Статус:** Approved (brainstormed)
**Scope:** Подсистемы (А) локальная директория знаний проекта + (Б) инъекция контекста в промпты всех моделей. MCP-интеграция (В) — вне scope, отдельный цикл.

---

## 1. Контекст и мотивация

z-cc-orchestrator — оркестратор для AI-CLI воркеров (claude/codex/glm/ollama) с kind-based диспетчеризацией. Каждый шаг воркфлоу — отдельный запуск сабпроцесса (`claude -p`, `codex exec`) или HTTP-запроса (api/ollama), получающий единый prompt-аргумент, собранный `buildWorkerPrompt` (`src/prompts/roles.ts:312`).

**Проблема:** воркеры stateless и не имеют персистентного знания о проекте, над которым работают. Каждый шаг начинается «с нуля» — нет памяти об архитектуре, доменных терминах, конвенциях, границах файлов. Качество каждого шага и результата в целом страдает.

**Цель:** при открытии проекта через UI создавать локальную директорию знаний (контекст проекта, архитектурные решения, логи), которая:
1. Не уходит в git проекта (хранится снаружи, централизованно).
2. Автонаполняется при открытии (роль `architect`).
3. Инъектируется в промпты всех моделей разом — через единую точку `buildWorkerPrompt`.

**Референс:** паттерн Lebedon `/.ai/` — нумерованные секции по жизненному циклу (00-project, 01-workflows, 02-prompts, 03-tasks, 04-skills, 05-context, 06-mcp, 07-output).

---

## 2. Принятые решения (сводка)

| Решение | Выбор |
|---|---|
| Масштаб цикла | Директория знаний + инъекция контекста (MCP — позже) |
| Расположение | Снаружи: `~/.orchestrator/projects/<slug>/` |
| Наполнение | Полный набор (8 секций Lebedon), lazy с заглушками |
| Автор контекста | Роль `architect` генерирует при открытии (только `00-project/`) |
| Наполнение `05-context/` | Пользователь вручную; деградация нормальна |
| Инъекция | В оркестраторе через `buildWorkerPrompt` (для всех моделей) |
| Триггер создания | UI-кнопка «Открыть проект» в RunForm |
| Обновление | Авто-логи после задачи, `00-project` immutable |
| Архитектурный подход | Минимально-инвазивный (новый модуль + 1 параметр в `buildWorkerPrompt`) |

---

## 3. Архитектура и расположение

### 3.1. Новый модуль `src/project-knowledge/`
Единственный ответственный за lifecycle директории знаний. Не затрагивает engine-ядро (runner/workflow/blackboard), только расширяет `buildWorkerPrompt` одним опциональным параметром.

Структура модуля:
```
src/project-knowledge/
  slug.ts          — slugFromPath: санитизация + коллизии
  registry.ts      — реестр ~/.orchestrator/projects.json (getOrCreate/find/update/list)
  context.ts       — loadProjectContextCache + buildProjectContext (по роли + обрезка)
  templates/       — статические файлы-заглушки (коммитятся в репо)
```

### 3.2. Физическое расположение директории знаний
```
~/.orchestrator/projects/<slug>/
  00-project/        product.md, architecture.md, code-map.md, glossary.md, stack-rules.md
  01-workflows/      feature-workflow.md, bugfix-workflow.md, refactor-workflow.md, research-workflow.md
  02-prompts/        01-discovery.md … 05-final-report.md
  03-tasks/          active-task.md, task-template.md, task-checklist.md
  04-skills/         .gitkeep (lazy — комментарий-заглушка)
  05-context/        file-allowlist.md, file-blocklist.md, naming-rules.md, done-definition.md
  06-mcp/            .gitkeep (lazy — MCP вне scope)
  07-output/         decisions.md, touched-files.md, validation-report.md, plan.md
  meta.json          # slug, projectPath, createdAt, lastOpenedAt, status, generatorModel
```

### 3.3. Slug-генерация
`slug = slugFromPath(projectPath)`:
- `toLowerCase`, не-`[a-z0-9-]` → `-`, схлопывание повторов.
- Коллизии (два разных пути дают один slug) — добавление `-<shortHash(absolutePath)>` (первые 8 символов SHA-256 от абсолютного пути).
- Mapping хранится в реестре (`projects.json`).

### 3.4. Что НЕ трогает
- `runner.ts`, `workflow.ts`, `blackboard.ts` — без изменений в их ядре (только расширение `runWorkflow` пробросом slug/ctxCache/activeTask).
- `dispatchWorker` — без изменений (инъекция происходит ДО него, в промпте).
- `.orchestrator/models.yaml`, `.orchestrator/state.json` — без изменений (только добавляется роль `architect` в role map).

### 3.5. Соответствие существующим паттернам
- JSON-файл-реестр + директория с данными = паттерн `blackboard.ts` (state.json + results/).
- Lazy-создание директорий через `mkdir({recursive:true})` = `initBlackboard` (blackboard.ts:66).
- Slug/путевые утилиты — рядом с `ui-backend/src/path-utils.ts` (`validateProjectPath`).

---

## 4. Создание директории знаний (роль `architect`)

### 4.1. Триггер и flow
Пользователь жмёт **«Открыть проект»** в RunForm → backend валидирует путь (`validateProjectPath`, уже есть) → проверяет существование директории знаний по slug:
- **Существует** → `status: ready`, открывается, ничего не генерируется.
- **Не существует** → создаётся скелет (все 8 секций с заглушками из `templates/`) + запускается **architect-фаза** для наполнения `00-project/`. `status: generating` → `ready`.

### 4.2. Workflow `workflows/project-init.yaml` (новый)
Линейный workflow без fan-out, один шаг:
```yaml
name: project-init
levels:
  - - id: discover
      role: architect
      agent: claude          # из role map
      budget: 5
```

### 4.3. Роль `architect` — новая 7-я роль
Добавляется в `Role` union (`src/envelope.ts`) и `ROLE_PROMPTS` (`roles.ts:284`).

**Назначение:** просканировать структуру проекта и сгенерировать 5 файлов `00-project/*.md`. Не editing-роль: не создаёт worktree, работает в cwd проекта только на чтение.

**Промпт:** инструктирует архитектора просканировать структуру проекта и вернуть **строгий JSON** (парсится раннером, как fan-out plan):
```json
{
  "product": "...",
  "architecture": "...",
  "code_map": "...",
  "glossary": "...",
  "stack_rules": "..."
}
```
Раннер пишет каждый ключ в соответствующий файл (маппинг ключ → файл):
- `product` → `00-project/product.md`
- `architecture` → `00-project/architecture.md`
- `code_map` → `00-project/code-map.md`
- `glossary` → `00-project/glossary.md`
- `stack_rules` → `00-project/stack-rules.md`

**Для пустого проекта** (нет `src/`, пустой `package.json`): architect генерирует скелет с TODO-заголовками и пометкой «проект пустой, заполнить после первой задачи».

### 4.4. Инъекция контекста в architect
Architect получает контекст через `buildWorkerPrompt`, но его контекст = **структура проекта** (live-скан), а не директория знаний (её ещё нет). Раннер передаёт `ls -la` корня + `package.json`/README/`tree -L 2` (если есть) в `context` поле. Это единственная роль, где context формируется не из `contextFromPrevStep`, а из live-сканирования проекта.

### 4.5. Роль `architect` в role map
Добавляется в `.orchestrator/models.yaml` роль `architect` → по умолчанию `claude` (сильная модель для качественной генерации контекста). Пользователь может переназначить в SettingsRoles.

### 4.6. Скелет-заглушки (создаются до architect-фазы)
Секции `01`–`07` создаются из `src/project-knowledge/templates/` (статические файлы). Только `00-project/` наполняется architect'ом; остальное — lazy или пользовательское.

Заглушки `04-skills/`, `06-mcp/` — `.gitkeep` + markdown с комментарием:
```markdown
<!-- 04-skills: доменные knowledge-модули. Наполняются по мере накопления
     экспертизы. Подгружаются инъекцией по роли/задаче. Пока пусто — нормально. -->
```

### 4.7. Что НЕ делает architect
- Не трогает `01-workflows`, `02-prompts` — это шаблоны оркестратора, копируются из `templates/`.
- Не пишет в `07-output/` — это append-only логи после задач.
- Не пишет `05-context/` — это политики пользователя.
- Не запускается повторно автоматически — только ручная кнопка «Регенерировать» ( позже).

### 4.8. Время выполнения
Один шаг, бюджет 5 мин. Для большого проекта промпт инструктирует «если не успел описать всё, пометь `...` и продолжи с важнейших зон». Скелет создаётся мгновенно.

---

## 5. Инъекция контекста в промпты (ядро подсистемы Б)

### 5.1. Точка инъекции
`buildWorkerPrompt` (`src/prompts/roles.ts:312`). Добавляется **один опциональный параметр** `projectContext?: string`:

```typescript
export function buildWorkerPrompt(input: {
  role: Role;
  agent: string;
  family?: string;
  task: string;
  context: string | null;
  targetPaths?: string[];
  fanOut?: boolean;
  projectContext?: string;  // НОВОЕ: секции из директории знаний
}): string {
```

Вставляется **после system prompt, до context предыдущего шага** — т.к. это стабильный контекст проекта, а не вывод конкретного шага:
```
<system prompt роли>
---
PROJECT CONTEXT:
<projectContext>
---
TARGET_PATHS: ...
CONTEXT (output from previous step): ...
---
TASK: <user prompt>
```

### 5.2. Соответствие роль→секции (финал)

| Роль | Секции (в порядке приоритета) |
|---|---|
| `plan` | `00-project/architecture.md` → `code-map.md` → `glossary.md` → `03-tasks/active-task.md` (из переменной) |
| `implement` / `refine` | `00-project/code-map.md` → `stack-rules.md` → `05-context/file-allowlist.md` → `file-blocklist.md` → `naming-rules.md` |
| `fix` | `00-project/code-map.md` → `stack-rules.md` → `05-context/done-definition.md` → `file-blocklist.md` |
| `review` | `00-project/code-map.md` → `05-context/done-definition.md` → `05-context/file-allowlist.md` |
| `final` | `03-tasks/active-task.md` (из переменной) → `05-context/done-definition.md` |
| `architect` | не инъектируется |

`05-context/` — политики пользователя, наполняются вручную. Если файл пуст/отсутствует — `buildProjectContext` пропускает его (не инъектирует пустоту). Первый прогон работает на `00-project/`, инъекция богатеет по мере наполнения `05-context/`.

### 5.3. Обрезка по границам секций (с fallback)
Жёсткий потолок ~6000 символов на всю инъекцию. Алгоритм:
1. Накапливаем секции в порядке приоритета (из таблицы 5.2 для данной роли).
2. Если следующая секция не влезает целиком — **не режем посередине**. Пытаемся обрезать по границе абзаца (`\n\n`).
3. **Fallback 1**: если в секции нет `\n\n` (architect отдаёт JSON-значения сплошным текстом) — режем по `\n`.
4. **Fallback 2**: если нет и `\n` — режем по символу с `…[truncated]`.
5. Низкоприоритетные секции, не влезшие целиком — **drop whole** (не cut partial). Не добавляем частичную секцию низкого приоритета.

Итог: либо секция входит целиком, либо обрезана по границе, либо отсутствует. Никогда не разрываем предложение/файл посередине без метки.

### 5.4. Кэш — честно immutable
`ctxCache` — `Map<filePath, string>`, union файлов `00-project/` + `05-context/`, прочитанных **один раз** в начале `runWorkflow`. **`active-task` в него не входит.** Никаких инвалидаций. Кэш immutable в пределах прогона.

Union файлов (полный список того, что читается в кэш):
- `00-project/architecture.md`, `code-map.md`, `glossary.md`, `stack-rules.md`, `product.md`
- `05-context/file-allowlist.md`, `file-blocklist.md`, `naming-rules.md`, `done-definition.md`

```typescript
const slug = slugFromPath(opts.project);
const ctxCache = await loadProjectContextCache(slug);  // одно чтение
```
`loadProjectContextCache` читает union файлов, которые могут понадобиться любой роли. Пропускает отсутствующие.

### 5.5. active-task — переменная в scope runWorkflow
Текущее состояние `active-task` — обычная переменная в `runWorkflow`, **не дисковое чтение**. Диск = только персистентность/архив.

**Жизненный цикл `active-task.md`:**

| Момент | Кто пишет | Что происходит |
|---|---|---|
| **Старт `runWorkflow`** (после `createTask`) | оркестратор | Формируем `activeTask` (title из prompt, goal = prompt целиком, scope = target_paths если есть, пустой AC-чеклист, timestamp). Пишем на диск для персистентности. Запоминаем `baseSha = git rev-parse HEAD` (для touched-files). |
| **После plan-шага** | оркестратор | Если plan вернул структурированные подзадачи/AC — парсим, обновляем `activeTask` в памяти, пишем на диск. Если markdown — оставляем как есть. |
| **Во время работы** | воркеры не пишут | Только читается через инъекцию (роль `final` сверяет против AC). |
| **Завершение задачи** (`acceptTask` или `status=done/failed`) | оркестратор | Архивирует: дописывает блок в `07-output/decisions.md` (итог), `07-output/touched-files.md` (`git diff --name-only <baseSha>...<integration-tip>`). `active-task.md` сбрасывается в `idle` шаблон. |
| **Регенерация контекста** (ручная, позже) | architect | Не трогает `active-task.md` — он оперативный, не часть `00-project`. |

**Формат `active-task.md`:**
```markdown
# Active Task
status: idle | in_progress
updated: 2026-07-11T14:30:00Z

## Goal
<user prompt or empty>

## Scope
- target_paths: <... or none>

## Acceptance Criteria
- [ ] <criterion from plan, or empty>

## Notes
<free-form>
```

### 5.6. Передача кэша и activeTask
Через `WorkerOnlyOpts` (уже пробрасывается в `runWorkerOnly` и `runFanOut`): добавляются поля `ctxCache?` и `activeTask?`.

```typescript
async function buildProjectContext(
  role: Role,
  ctxCache: Map<string, string>,
  activeTask: string | null,
): Promise<string | null>
```
Чистая функция над данными в памяти: выбирает из кэша по роли, вставляет `activeTask` где роль требует, применяет приоритет + обрезку.

### 5.7. Как раннер узнаёт slug
`runWorkerOnly` (runner.ts:190) уже получает `projectPath`. В начале `runWorkflow` (runner.ts:824) после разрешения slug — пробрасывается через `WorkerOnlyOpts` в `runWorkerOnly`, где перед вызовом `buildWorkerPrompt`:
```typescript
const projectContext = await buildProjectContext(step.role, ctxCache, activeTask);
const fullPrompt = buildWorkerPrompt({ ..., projectContext });
```
Fan-out (`runFanOut`) — аналогично пробрасывает slug/ctxCache/activeTask в подзадачи.

### 5.8. Деградация
- Нет директории знаний → `ctxCache` пуст → `projectContext = null` → `buildWorkerPrompt` работает как раньше (обратно совместимо).
- Часть файлов отсутствует → читаются только существующие.
- `slug` невалиден → `null`, логируем warning в `.orchestrator/log/`.

### 5.9. Почему работает «для всех моделей разом»
`projectContext` становится частью `envelope.prompt` — единственного аргумента, который получает каждый воркер. `claude -p "<prompt>"`, `codex exec "<prompt>"`, HTTP body api/ollama — все видят контекст одинаково. Никаких per-model хуков, `--system-prompt` флагов, `extraArgs`.

### 5.10. Что НЕ инъектируется
- `07-output/decisions.md`, `touched-files.md` — растут без ограничений, не для инъекции.
- `01-workflows/`, `02-prompts/` — шаблоны оркестратора, не контекст для воркеров.
- `06-mcp/` — вне scope этого цикла.

---

## 6. Реестр проектов + UI

### 6.1. Реестр `~/.orchestrator/projects.json`
Один JSON-файл, mapping slug → метаданные. Следует паттерну `blackboard.ts` (state.json).

```typescript
interface ProjectRegistryEntry {
  slug: string;
  projectPath: string;        // абсолютный путь к git-репо
  createdAt: string;          // ISO
  lastOpenedAt: string;       // ISO, обновляется при открытии
  status: "ready" | "generating" | "failed";
  knowledgeDir: string;       // ~/.orchestrator/projects/<slug>/
  generatorModel?: string;    // какая модель генерила 00-project
  lastError?: string;         // если status=failed
}
interface ProjectRegistry { projects: ProjectRegistryEntry[]; }
```

Мьютекс на запись — как `stateMutex` в blackboard.ts.

### 6.2. Модуль `src/project-knowledge/registry.ts`
```typescript
export async function getOrCreateProject(projectPath: string): Promise<ProjectRegistryEntry>
//  • slug = slugFromPath(projectPath)
//  • если запись есть → обновить lastOpenedAt, вернуть
//  • если нет → создать скелет директории, запись status=generating, вернуть

export async function findProject(slug: string): Promise<ProjectRegistryEntry | null>
export async function updateProjectStatus(slug: string, status, lastError?): Promise<void>
export async function listProjects(): Promise<ProjectRegistryEntry[]>
```

### 6.3. Backend API (`ui-backend`)
Новый `ProjectsController` + `ProjectsService` (рядом с `models.controller.ts`):

| Метод | Путь | Что делает |
|---|---|---|
| `POST` | `/projects/open` | body: `{ projectPath }`. Валидация пути → `getOrCreateProject` → если `generating`: запускает workflow `project-init` (сабпроцесс `tsx src/cli.ts --project <path> --workflow project-init`) → возвращает entry + статус. |
| `GET` | `/projects` | `listProjects()` — для будущего recent-list. |
| `GET` | `/projects/:slug` | детали + статус генерации. |
| `POST` | `/projects/:slug/regenerate` | перегенерация `00-project/` (manual, для будущего). |

Запуск architect-фазы — через существующий `ProcessManager` (умеет спавнить `tsx src/cli.ts` и стримить логи). Отдельный ключ клиента, чтобы UI видел прогресс генерации в LiveLog.

### 6.4. CLI расширение
`src/cli.ts` — новый флаг `--init-project`: запускает workflow=project-init и формирует служебный prompt для architect (сканировать структуру, вернуть JSON). `/projects/open` (секция 6.3) вызывает именно `--init-project`, а не голый `--workflow project-init` — флаг гарантирует, что architect получит служебный init-prompt, а не пользовательскую задачу.

### 6.5. UI: кнопка «Открыть проект» в RunForm
Расширение `ui-web/src/widgets/run-form/RunForm.tsx`:

```
┌─ Запуск задачи ─────────────────────────────────┐
│ [textarea: опиши задачу]                        │
│ Воркфлоу [default▾]  Проект [путь________] [Открыть]│
│                      🟢 z-cc-orchestrator (ready)   │
│ [Запустить]                                     │
└─────────────────────────────────────────────────┘
```

- Кнопка **«Открыть»** рядом с полем «Проект». Активна когда путь непустой и валидный.
- После клика → `POST /projects/open` → индикатор статуса:
  - 🟡 `generating` — architect работает, прогресс в LiveLog
  - 🟢 `ready` — директория готова
  - 🔴 `failed` — ошибка (показать `lastError`)
- При `ready` — кнопка «Запустить» активна (задача пойдёт с инъекцией контекста). При `generating` — можно запустить, но без контекста (деградация).
- Поле «Проект» связано с реестром: при вводе пути, который уже в реестре — показываем slug/статус без повторного «Открыть».

### 6.6. `shared/api` расширение
Новые методы в `api` объекте (`ui-web/src/shared/api/index.ts`):
```typescript
openProject: (projectPath: string) => api.post('/projects/open', { projectPath }),
getProject: (slug: string) => api.get(`/projects/${slug}`),
listProjects: () => api.get('/projects'),
```

### 6.7. Что НЕ делает UI в этом цикле
- Отдельной страницы `/projects` нет (подход 1 — минимально-инвазивный).
- Редактирование файлов директории знаний через UI — нет.
- Recent-list dropdown — нет (API готов, UI позже).

---

## 7. Шаблоны и edge-cases

### 7.1. Шаблоны `src/project-knowledge/templates/`
Статические файлы-заглушки, копируемые при создании скелета. Коммитятся в репо оркестратора (статика, не runtime):

```
templates/
  00-project/.gitkeep
  01-workflows/feature-workflow.md, bugfix-workflow.md, refactor-workflow.md, research-workflow.md
  02-prompts/01-discovery.md … 05-final-report.md
  03-tasks/active-task.md, task-template.md, task-checklist.md
  04-skills/.gitkeep
  05-context/file-allowlist.md, file-blocklist.md, naming-rules.md, done-definition.md
  06-mcp/.gitkeep
  07-output/decisions.md, touched-files.md, validation-report.md, plan.md
  meta.json.template
```

При `getOrCreateProject` — рекурсивное копирование в `~/.orchestrator/projects/<slug>/`.

### 7.2. Edge-cases

| Случай | Поведение |
|---|---|
| Путь не git-репо | `validateProjectPath` падает с понятной ошибкой. Кнопка «Открыть» деактивирована. |
| Пустой проект (нет src/, пустой package.json) | architect генерирует `00-project/` с TODO-заголовками, пометкой «проект пустой». Скелет создаётся. |
| Slug-коллизия (разные пути, один basename) | добавляем `-<shortHash(absPath)>`. Запись в реестре хранит полный путь. |
| Директория знаний существует, но `00-project/` пуст (прерванная генерация) | `status=generating` в реестре → предлагаем перегенерировать. |
| architect не уложился в бюджет | `00-project/` частично заполнен, пометки `...`. `status=ready` (частичный контекст лучше нуля). Логируем warning. |
| Модель `architect` unhealthy | health-gate в `runWorkflow` падает до старта. UI показывает ошибку. |
| Параллельные «Открыть» один проект | мьютекс в реестре + проверка статуса: если уже `generating` — возвращаем существующую запись. |
| `~/.orchestrator/` не существует | `mkdir({recursive:true})` (как `initBlackboard`). |
| Проект перемещён | `projectPath` невалиден → при открытии помечаем `status=failed`, просим переввести. |
| Fan-out подзадачи | slug/ctxCache/activeTask пробрасываются в `runFanOut` → каждая подзадача получает тот же кэш. Контекст консистентен. |

---

## 8. Тестирование

### 8.1. Unit-тесты
- `slugFromPath` — санитизация, коллизии, unicode.
- `buildProjectContext` — выбор секций по роли, обрезка по `\n\n` / `\n` / символу, drop-whole, пустые файлы пропускаются.
- `loadProjectContextCache` — читает union, пропускает отсутствующие.
- Жизненный цикл `activeTask` — старт/plan-обновление/архивация, baseSha для touched-files.
- Реестр — create/find/update, мьютекс, slug-коллизии.

### 8.2. Интеграционные (через smoke-паттерн `scripts/smoke-*.ts`)
- `smoke-project-init.ts` — на тестовом проекте: открыть → сгенерировать → проверить структуру `00-project/`.
- `smoke-injection.ts` — запустить workflow на проекте с директорией знаний, проверить что `envelope.prompt` содержит секции контекста.
- `smoke-degradation.ts` — проект без директории знаний → шаг выполняется, `projectContext=null`, обратно совместимо.

### 8.3. E2E (ручное)
UI-кнопка «Открыть» → индикатор → запуск задачи → проверка что контекст в промпте.

---

## 9. Границы этого цикла (явное YAGNI)
- ❌ MCP-интеграция (следующий цикл).
- ❌ Skills-система как отдельная сущность (секции `04-skills/` — заглушки, наполняются вручную, инъекции по роли пока нет).
- ❌ Страница `/projects`, recent-list dropdown.
- ❌ Редактирование файлов директории знаний через UI.
- ❌ Авто-регенерация `00-project/` (только ручная кнопка, позже).
- ❌ Per-project model config (подход 2 — не в этом цикле).

---

## 10. Файлы, затрагиваемые имплементацией

| Файл | Тип изменения |
|---|---|
| `src/project-knowledge/slug.ts` (новый) | slug-генерация |
| `src/project-knowledge/registry.ts` (новый) | реестр projects.json |
| `src/project-knowledge/context.ts` (новый) | кэш + buildProjectContext |
| `src/project-knowledge/templates/` (новый) | статические заглушки |
| `src/prompts/roles.ts` | роль `architect` + параметр `projectContext` в `buildWorkerPrompt` |
| `src/envelope.ts` | расширить `Role` union: `architect` |
| `src/runner.ts` | slug + ctxCache + activeTask переменная + baseSha + архивация |
| `src/cli.ts` | флаг `--init-project` |
| `workflows/project-init.yaml` (новый) | workflow для architect-фазы |
| `.orchestrator/models.yaml` | роль `architect` → claude в role map |
| `ui-backend/src/projects.controller.ts` (новый) | REST API |
| `ui-backend/src/projects.service.ts` (новый) | бизнес-логика |
| `ui-backend/src/process-manager.service.ts` | запуск architect-фазы (переиспользование) |
| `ui-web/src/shared/api/index.ts` | методы openProject/getProject/listProjects |
| `ui-web/src/widgets/run-form/RunForm.tsx` | кнопка «Открыть» + индикатор статуса |
| `ui-web/src/entities/` | типы ProjectEntry, ProjectStatus |
| `scripts/smoke-project-init.ts` (новый) | интеграционный тест |
