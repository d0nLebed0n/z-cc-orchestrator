# Дизайн: Локальный исполнитель (Ollama) + fan-out в раннере

**Дата:** 2026-07-10
**Статус:** Approved (brainstormed)

## Контекст и цель

В Tailscale-сети на `d0nlebed0n.tail74ba62.ts.net:11434` поднят **Ollama 0.31.2** с двумя моделями:

- `danielsheep/Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS` — кодинг-модель, 30.5B (MoE, A3B активных), контекст 1M, поддерживает `tools` capability (но нативный tool-call через `tool_calls` у квантизованной Unsloth-модели **не работает** — формат уходит в `content` как `<tools>{...}</tools>`).
- `nomic-embed-text:latest` — 768-мерные эмбеддинги (RAG-слой, **отложен**, см. Out of scope).

Обе модели проверены: отвечают по OpenAI-совместимому `/v1/chat/completions` и родному `/api/*`.

**Цель интеграции** — не экономия денег (подписки claude/codex/glm оплачены), а **дополнительная параллельная ёмкость** на атомарных подзадачах, которые декомпозировал Claude. Ключевая идея: Claude декомпозирует задачу и **оценивает сложность** каждой подзадачи; по порогу сложности тривиальные уходят в бесплатную локальную модель, сложные — в оплаченный glm; каждый результат независимо ревьюит codex.

## Архитектура

### Поток воркфлоу `decomposed`

```
claude(plan) ── JSON-план: N подзадач, каждой — complexity 0..100
                 │
                 ▼
        ┌─── FAN-OUT ────────────────────────────────┐
        │ для каждой подзадачи (≤ max_parallel):      │
        │   complexity ≥ threshold → glm(implement)    │
        │   complexity <  threshold → ollama(implement)│
        │   codex(review)            ─ независимый      │
        └─────────────────────────────────────────────┘
                 │
                 ▼
        integration (все смерженные подзадачи)
```

### Три новых сущности

1. **Семья `local` + агент `ollama`** в `families.ts`. Кросс-семейное ревью начинает действовать для 4 семей автоматически (`validReviewerFamilies`).
2. **Воркер `runOllama`** — tool-calling agent-loop: парсит `<tools>{read_file|write_file|list_dir}</tools>` из `content`, исполняет вызовы, пишет в worktree.
3. **Декларативный шаг `fan_out`** в схеме воркфлоу — раннер динамически раскрывает один такой шаг в N пар (implement+review) по плану из plan-шага.

### Принципы

- **Раннер владеет раскрыванием** fan-out: парсит JSON-план, создаёт N step-record'ов, гонит через `maxParallel`. Каждый шаг получает свой worktree.
- **Маршрутизация по порогу**: `agent = subtask.complexity >= threshold ? glm : ollama`. Суждение (complexity) — за Claude, политика (threshold) — параметр воркфлоу.
- **Поэлементное ревью**: каждой подзадаче свой codex(review). Сбой одной подзадачи не валит остальные.
- **Мягкая обработка частичных провалов**: failed подзадачи не роняют fan-out; задача `done` только если все APPROVE.

## Схема данных

### Семьи и агенты (`families.ts`)

```ts
type Family = "anthropic" | "openai" | "zai" | "local";
type AgentName = "claude" | "codex" | "glm" | "ollama";

AGENTS["ollama"] = { name: "ollama", family: "local", binary: "ollama" };
// "local" добавляется в общий список в validReviewerFamilies.
```

Контракт `WorkerResult`/`WorkerFn` — **без изменений**.

### План декомпозиции (новый файл `src/plan.ts`)

```ts
SubtaskSchema = {
  id: string,                                  // стабильный id, напр. "P1"
  title: string,                               // краткое имя
  goal: string,                                // полная спека подзадачи
  complexity: number().int().min(0).max(100),  // оценка Claude
  target_paths: string[],                      // область правок (worktree + непересечения)
  acceptance_criteria: string,                 // как codex поймёт, что готово
}
SubtaskPlanSchema = { subtasks: SubtaskSchema[] }
```

Парсер `parsePlan(output: string): SubtaskPlan` — достаёт JSON из вывода Claude, валидирует zod. Сбой парсинга/валидации → ошибка → HITL.

`agent` **выводится** раннером по complexity, а не задаётся в плане.

### Шаг `fan_out` в `WorkflowStepSchema` (`workflow.ts`)

Опциональные поля на шаг (существующие воркфлоу не ломаются):

```yaml
steps:
  - id: build
    fan_out: true        # объявляет шаг раскрывателем
    from_plan: plan      # чей вывод парсить как SubtaskPlan (обязательно)
    agents: [glm, ollama]# допустимые исполнители (обязательно)
    review: true         # добавить codex(review) на каждую подзадачу (default false)
    role: implement      # роль раскрываемых implement-шагов
    depends_on: [plan]
    budget: {...}        # бюджет на КАЖДУЮ реализацию отдельно
```

```ts
fan_out?: boolean;
from_plan?: string;          // обязательно при fan_out:true
agents?: AgentName[];        // обязательно при fan_out
review?: boolean;            // default false
```

### Параметр `complexity_threshold`

Параметр **уровня воркфлоу** (YAGNI: кейса с >1 fan_out нет):

```yaml
complexity_threshold: 80   # 0..100, default 80
max_parallel: 3            # потолок параллельных реализаций
```

| threshold | Поведение |
|---|---|
| 80 (default) | ~простейшие 20% в ollama, основная масса в glm |
| 100 | всё в glm, ollama не зовётся |
| 0 | всё в ollama, glm не зовётся |
| 50 | сбалансированно |

При раскрывании сторона порога маппится на семью:
- `complexity >= threshold` → **strong** (любая non-local семья: anthropic/openai/zai)
- `complexity < threshold` → **local** (семья local)

Из `spec.agents` выбирается **первый** (в порядке списка) агент подходящей стороны:
- strong → первый агент из `agents`, чья семья ≠ local (напр. `[glm, ollama]` → glm)
- local → первый агент из `agents`, чья семья = local (напр. `[glm, ollama]` → ollama)

Если в `agents` нет подходящей стороны для данной подзадачи → HITL, подзадача пропускается (напр. `agents: [glm]` и подзадача complexity < threshold — некому отдать в local).

## Воркер `runOllama` (tool-loop)

### Протокол цикла

```
цикл (max N итераций):
  1. POST /v1/chat/completions  (system + user + нак. история)
  2. парсим ответ:
     ├── <tools>{"name":"read_file","arguments":{...}}</tools>
     │     → исполняем tool, добавляем {role:"tool", content: результат}
     │     → продолжаем цикл
     ├── <tools>{"name":"write_file",...}</tools>
     │     → пишем файл в worktree, добавляем результат
     │     → продолжаем
     └── текст без <tools> → модель закончила → выход
выход: лимит итераций ИЛИ чистый текст без tool-вызова
```

### HTTP-клиент

- Эндпоинт `/v1/chat/completions` на `OLLAMA_BASE_URL` (env, дефолт `http://d0nlebed0n.tail74ba62.ts.net:11434`).
- Модель = `OLLAMA_MODEL` env (дефолт — полный тег `danielsheep/Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS`).
- `temperature: 0`, `fetch` (Node ≥ 18), без новых зависимостей.
- System-промпт (ветка ollama в `prompts/roles.ts`): каталог инструментов + формат вызова + «в конце дай итоговый текст».

### Сигналы успеха (`WorkerResult`)

Те же 3 сигнала, что у claude:

1. `exit_0` → HTTP 200 + корректный JSON.
2. `nonempty_output` → итоговый текст непустой.
3. `files_changed` (для implement/refine/fix) → `git status --porcelain` непустой.

`reason`: сетевой сбой/HTTP≠200 → `error`; таймаут → `timeout`; цикл без правок → `no_changes`. Ретраи в пределах `max_steps` — переиспользуются из `runStep`.

### Защита от зацикливания (главный риск 30B)

- **Лимит итераций**: жёсткий потолок `max_steps × 8` (напр. `max_steps=2` → 16 итераций), сверх → `reason: no_changes`/`error`.
- **Дедупликация tool-вызовов**: повторный `read_file` того же пути подряд → возвращаем «already read», не исполняем повторно.
- **Общий таймбокс** = `budget.wall_time_sec` (цикл проверяет `Date.now() - start`).

### Локализация tool-исполнителей

Инструменты (`read_file`/`write_file`/`list_dir`) — в воркере (`workers/ollama-tools.ts`), работают относительно `opts.cwd` (worktree). Path-sanitize: reject `..` выход за `cwd`.

## Fan-out механика в раннере

### Изменение в `buildLoadedWorkflow` (компиляция)

Шаг с `fan_out: true` **исключается** из обычных `preLevels`, регистрируется в новом поле:

```ts
interface LoadedWorkflow {
  wf, preLevels, loopBody, loop, postLevels, allSteps,
  fanOuts: FanOutSpec[],
}
interface FanOutSpec {
  step: ResolvedStep;
  fromPlanId: string;
  agents: AgentName[];
  review: boolean;
}
```

### Новый проход в `runWorkflow` (рантайм)

```
for level in preLevels:
    исполнить как обычно
    если уровень содержит fan_out-шаг:
        1. прочитать результат plan-шага (fromPlanId)
        2. parsePlan(output) → SubtaskPlan
        3. для каждой subtask:
             вычислить agent по complexity vs threshold
             проверить agent ∈ spec.agents (иначе HITL)
             материализовать implement [+ review] ResolvedStep
        4. проверить target_paths на пересечение (assertNonOverlappingPaths) → HITL при пересечении
        5. исполнить уровень по max_parallel батчами
        6. мерж каждой успешной пары в integration
```

### Идемпотентность stepId и merge

ID материализованных шагов: `build#P1`, `build#P1#review`. Базовый индекс = `allSteps.indexOf(spec.step) + 1` (позиция fan_out-шага в `allSteps`); суффикс `#<subtaskId>` добавляется к id и к stepId, чтобы различать подзадачи в blackboard. Уникально, traceable. Merge каждой пары последовательно (через существующий `mergeWorktree`).

`runStep` дорабатывается: принимает опциональный `idSuffix` (`#P1`), который подставляется в `newStepId` и в id `StepRecord`, чтобы материализованные шаги не коллизировали с шаблоном `build`.

### Обработка вердиктов в fan-out

- `APPROVE` → мержим подзадачу в integration.
- `REQUEST_CHANGES` → подзадача failed, не мержится, fan-out продолжается.
- `REJECT` → то же (failed), логируется.

Финальный статус: `done` если **все** APPROVE; иначе `escalated_hitl` (с указанием провалившихся).

### Бюджет и circuit breaker

- `spec.step.budget` применяется к **каждой** реализации отдельно.
- `CircuitBreaker` срабатывает по агенту: 3 провала ollama → оставшиеся ollama-подзадачи HITL, glm-подзадачи продолжаются.

### Кросс-семейная валидация

- **Статически** (компиляция): при `fan_out: true, review: true` проверяем, что в `agents` нет openai (codex — ревьюер).
- **Рантайм**: после вычисления agent — `reviewer.family !== implementer.family`, иначе HITL.

## Воркфлоу `decomposed.yaml`

```yaml
name: decomposed
description: |
  Claude декомпозирует → fan-out на glm (сложное) + ollama (простое),
  каждая подзадача независимо ревьётся codex.
complexity_threshold: 80
max_parallel: 3

steps:
  - id: plan
    agent: claude
    role: plan
    effort: high
    budget: { wall_time_sec: 900, max_steps: 2 }
    depends_on: []

  - id: build
    fan_out: true
    from_plan: plan
    agents: [glm, ollama]
    review: true
    role: implement
    depends_on: [plan]
    budget: { wall_time_sec: 1200, max_steps: 2 }

  - id: final
    agent: claude
    role: final
    effort: high
    budget: { wall_time_sec: 900, max_steps: 2 }
    depends_on: [build]
```

## Error handling — дерево отказов

| Сбой | Реакция |
|---|---|
| plan-шаг провален / non-JSON | `parsePlan` бросает → HITL, задача `escalated_hitl` |
| Подзадача с complexity не под исполнителя | HITL, подзадача пропускается |
| `target_paths` подзадач пересекаются | HITL при материализации, до запуска |
| ollama: сетевой сбой / 5xx | ретраи в пределах `max_steps`, затем failed |
| ollama: зацикливание | `reason: no_changes`/`error`, failed |
| codex(review) REJECT | failed, не мержится, fan-out продолжается |
| Circuit breaker на ollama (3 провала) | оставшиеся ollama → HITL, glm продолжаются |
| Health-gate: Ollama недоступен | запуск не начинается |

## Тесты

Расширение `scripts/smoke*.ts`:

**Unit (без сети):**
- `families.ts`: `ollama` в `AGENTS`, `validReviewerFamilies("local")` = [anthropic, openai, zai].
- `plan.ts`: `parsePlan` на валидном/мусорном/пустом → ok/throw.
- `workflow.ts`: `fan_out` компилируется; без `from_plan`/`agents` — ошибка; `from_plan` ссылается вперёд — ошибка.
- Маршрутизация: complexity 85/threshold 80 → glm; 70/80 → ollama; threshold 100 → все glm; 0 → все ollama.

**Smoke (с сетью на ollama):**
- `runOllama` на тривиальной задаче → `has_changes: true`, `success: true`.
- Health-gate пингует `OLLAMA_BASE_URL`.
- E2E: воркфлоу `decomposed` целиком (plan→fan-out→final).

## Файлы

**Создать:**
- `src/plan.ts` — `SubtaskSchema`, `SubtaskPlanSchema`, `parsePlan()`.
- `src/workers/runOllama.ts` — tool-loop воркер.
- `src/workers/ollama-tools.ts` — инструменты + path-санитайз.
- `workflows/decomposed.yaml`.
- `scripts/smoke-local.ts` — проверки ollama.

**Изменить:**
- `src/families.ts` — семья `local`, агент `ollama`.
- `src/envelope.ts` — `ollama`/`local` в enums.
- `src/workflow.ts` — поля fan_out + `FanOutSpec` + `complexity_threshold`/`max_parallel`.
- `src/prompts/roles.ts` — ветка ollama.
- `src/workers/index.ts` — `runOllama` в `WORKERS`.
- `src/workers/health.ts` — health для ollama.
- `src/runner.ts` — расширение fan-out + маршрутизация + вердикты.
- `src/cli.ts` — `OLLAMA_*` env wiring.
- `.env.example` / `.env.local` — `OLLAMA_BASE_URL` / `OLLAMA_MODEL`.

## Out of scope (YAGNI)

- **RAG / nomic-embed-text** — отложен (спутник локального агента, отдельная итерация).
- Fan-out внутри `loop`/`post_steps` — только pre-loop.
- Несколько fan_out-шагов на воркфлоу.
- Tool `apply_diff` — начали с read/write/list.
- Роутинг на ролях субагентов (test/refine) — только `implement`.
- Web UI правки под fan-out — материализованные шаги уже пишутся в `state.json`, спец.отображение позже.
