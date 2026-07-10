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

1. **Семья `local` + агент `ollama`** в `families.ts`. `local` — implement-only семья: она участвует в кросс-семейной проверке как автор, но не попадает в кандидаты ревьюеров.
2. **Воркер `runOllama`** — tool-calling agent-loop: парсит `<tools>{read_file|write_file|list_dir}</tools>` из `content`, исполняет вызовы, пишет в worktree.
3. **Декларативный шаг `fan_out`** в схеме воркфлоу — раннер динамически раскрывает один такой шаг в N пар (implement+review) по плану из plan-шага.

### Принципы

- **Раннер владеет раскрыванием** fan-out: парсит JSON-план, создаёт N step-record'ов, гонит через `maxParallel`. Каждый шаг получает свой worktree.
- **Маршрутизация по порогу**: `agent = subtask.complexity >= threshold ? glm : ollama`. Суждение (complexity) — за Claude, политика (threshold) — параметр воркфлоу: всё, что ниже порога, считается достаточно простым для local.
- **Поэлементное ревью**: каждой подзадаче свой codex(review). Сбой одной подзадачи не валит остальные.
- **Мягкая обработка частичных провалов**: failed подзадачи не роняют fan-out; задача `done` только если все APPROVE.

## Схема данных

### Семьи и агенты (`families.ts`)

```ts
type Family = "anthropic" | "openai" | "zai" | "local";
type AgentName = "claude" | "codex" | "glm" | "ollama";

AGENTS["ollama"] = { name: "ollama", family: "local", binary: "ollama" };
// "local" НЕ добавляется в список ревьюеров: local может писать, но не ревьюить.
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

> ⚠️ **`max_parallel` имеет два источника.** Он уже приходит как `RunOptions.maxParallel` (CLI, default 3) и потребляется в `runWorkflow`. Добавляя его в `WorkflowSchema`, зафиксировать приоритет: **CLI-опция > YAML > default 3** (CLI override для оперативного throttling). YAML-значение — потолок «по замыслу воркфлоу», CLI — «по железу прямо сейчас». Итог: `effectiveMaxParallel = opts.maxParallel ?? wf.max_parallel ?? 3`.

| threshold | Поведение |
|---|---|
| 80 (default) | complexity 0..79 → ollama, 80..100 → glm |
| 100 | почти всё в ollama (0..99); только complexity 100 → glm |
| 0 | всё в glm, ollama не зовётся (нет complexity < 0) |
| 50 | complexity 0..49 → ollama, 50..100 → glm |

При раскрывании сторона порога маппится на семью:
- `complexity >= threshold` → **strong** (любая non-local семья: anthropic/openai/zai)
- `complexity < threshold` → **local** (семья local)

Из `spec.agents` выбирается **первый** (в порядке списка) агент подходящей стороны:
- strong → первый агент из `agents`, чья семья ≠ local (напр. `[glm, ollama]` → glm)
- local → первый агент из `agents`, чья семья = local (напр. `[glm, ollama]` → ollama)

Если в `agents` нет подходящей стороны для данной подзадачи → HITL, подзадача пропускается (напр. `agents: [glm]` и подзадача complexity < threshold — некому отдать в local).

> Если нужно настроить поведение в терминах «максимальная сложность для local», можно позже переименовать параметр в `local_max_complexity`. В этой версии оставляем `complexity_threshold`, но фиксируем точную семантику: `complexity < threshold` идёт в local, `complexity >= threshold` — в strong.

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
             проверить agent ∈ spec.agents (иначе HITL, подзадача пропущена)
             материализовать implement (+ review при spec.review) ResolvedStep
        4. проверить target_paths на пересечение (normalize + parent/child overlap) → HITL при пересечении
        5. ФАЗА A (параллельно, по max_parallel): только implement-шаги.
             Каждый в СВОЁМ worktree (ветка <agent>~<subtaskId>). Коммитим, но не мержим в integration.
        6. ФАЗА B (строго последовательно): для каждой успешной implement-подзадачи:
             создать candidate от текущей integration → merge implement-ветку в candidate
             → run review в candidate-worktree → verdict
             → APPROVE: ff/merge candidate в integration; иначе candidate удаляется
             (см. §«Параллелизм и integration-worktree» — почему B не параллелится)
        7. агрегировать вывод подзадач для downstream (см. §«Downstream-контекст»)
```

### Параллелизм и integration-worktree

Ревью и merge завязаны на **единственный** integration-worktree: `runStep` для ролей review/final делает `git merge --ff-only` и работает в общем `integrationWtPath`. Параллельный запуск нескольких review/merge → **гонка по HEAD integration-ветки**. Кроме того, ревью нельзя запускать после безусловного merge в integration: если `codex` вернёт `REQUEST_CHANGES`/`REJECT`, отклонённые изменения уже окажутся в общей ветке.

Поэтому fan-out использует двухступенчатый merge:

1. **Фаза A**: implement-подзадачи параллельно пишут и коммитят изменения в собственные ветки/worktree, но не мержатся в integration.
2. **Фаза B**: оркестратор строго последовательно создаёт disposable candidate-ветку от текущей integration, мержит туда одну implement-ветку, запускает review в candidate-worktree и только при `APPROVE` продвигает integration до candidate.

Следствия:

- **Фаза A** (implement) параллелится по `max_parallel` — каждый в своей ветке, merge отложен.
- **Фаза B** (candidate merge + review + approved merge) — **последовательная**, даже если реализаций много. Это осознанный trade-off: выигрыш параллелизма — на самой долгой части (генерация кода моделью), а merge+review дёшевы и не стоят гонки.
- Как следствие: `runStep` в текущем виде слишком монолитен для fan-out. Его нужно разложить на внутренние операции (`runWorkerOnly`, `commitWorkerChanges`, `runReviewInCwd`, `mergeCandidateToIntegration`) или дать ему явные опции `deferMerge`/`cwdOverride`; предпочтительнее декомпозиция, чтобы не смешивать обычный linear-run и fan-out protocol.

### Ограничение параллелизма

`max_parallel` должен быть реальным bounded pool, а не только вычисленным числом. В текущем `runner.ts` для параллельного уровня считается `concurrency`, но затем запускается `Promise.all(level.map(...))`, то есть весь уровень стартует сразу. Fan-out должен использовать общий helper вида `runBounded(items, maxParallel, fn)`, иначе большая декомпозиция может одновременно поднять все GLM/Ollama воркеры.

### Пересечение target_paths: строгий предзапрет (v1) vs merge-first (позже)

Шаг 4 материализации делает **HITL при любом пересечении** `target_paths` (нормализованном, parent/child — пункт №11). Это осознанно консервативно, а не необходимость: с disposable candidate подзадачи мержатся **последовательно**, поэтому реальный git-конфликт всплыл бы естественно при merge в candidate и дал бы понятный сигнал. Две подзадачи, правящие один файл в непересекающихся местах, смержились бы чисто — строгий предзапрет их зря заблокирует.

**v1 (эта версия): строгий предзапрет.** Пересечение → HITL до запуска. Плюсы: детерминизм, никакого недорасхода токенов на подзадачи, которые всё равно упрутся в конфликт; область каждой подзадачи гарантированно изолирована. Минус: ложные HITL на файлах, где правки не конфликтуют.

**Путь ослабления (отдельная итерация, YAGNI сейчас): merge-first.** Разрешить пересечения, дать фазе B пробовать merge candidate; HITL только на **фактический** git-конфликт. Требует детерминированного порядка подзадач в фазе B (напр. по `subtask.id`), чтобы «кто первый смержил файл» было воспроизводимо, и понятной трактовки: конфликтующая подзадача — failed (как REJECT), fan-out продолжается. Не делаем в v1, но предзапрет намеренно живёт в **одном** месте (шаг 4 / `assertNonOverlappingPaths`), чтобы снять его точечно.

### Downstream-контекст (агрегация вывода fan_out)

`contextFromPrevStep` резолвит вывод dep-шага через `newStepId(taskId, allSteps.indexOf(dep)+1, iteration)` — он **не знает** про суффиксы `~P1` и вернёт `null` для потребителя fan_out-шага (напр. `final` с `depends_on: [build]`). Поэтому раннер после фазы B **записывает агрегированный результат под базовым stepId fan_out-шага** (`taskId-S02`, без суффикса): конкатенация `title + verdict + краткий вывод` каждой подзадачи. Тогда `contextFromPrevStep` находит его штатно, а `final` видит сводку по всем подзадачам.

### Идемпотентность stepId и merge

> ⚠️ **Разделитель `#` уже занят циклом.** `newStepId` (blackboard.ts) отдаёт `taskId-S03#2` для итерации цикла > 1. Значит `#` **нельзя** переиспользовать под подзадачу — `S03#P1` неотличим от итерации, а `#P1#review` создаёт трёхуровневую неоднозначность. Fan-out использует **отдельный сегмент `~`**: подзадача — `~P1`, её review — `~P1r`.

ID материализованных шагов: `taskId-S02~P1` (implement), `taskId-S02~P1r` (review). Базовый индекс = `allSteps.indexOf(spec.step) + 1` (позиция fan_out-шага в `allSteps`). Полная схема сегментов stepId: `<base>[#<iteration>][~<subtask>[r]]` — цикл и fan-out ортогональны и не пересекаются (fan-out только pre-loop, см. Out of scope). Уникально, traceable.

`runStep`/новые низкоуровневые helper-ы дорабатываются: принимают опциональный `subtaskSuffix` (`~P1` / `~P1r`), который подставляется:
- в `newStepId` → id `StepRecord` и путь результата;
- **в имя worktree-ветки** (`createWorktree(projectPath, taskId, \`${step.agent}~P1\`)`) — иначе N ollama-подзадач получат одинаковую ветку `<taskId>/ollama` и worktree-и **коллизируют** (см. Несостыковки №4).

Merge каждой одобренной пары в integration — **строго последовательно**, вне параллельного батча (см. §«Параллелизм и integration-worktree»).

### Обработка вердиктов в fan-out

- `APPROVE` → продвигаем integration до candidate с подзадачей.
- `REQUEST_CHANGES` → candidate удаляется, подзадача failed, fan-out продолжается.
- `REJECT` → то же (failed), логируется.

Финальный статус: `done` если **все** APPROVE; иначе `escalated_hitl` (с указанием провалившихся).

### Бюджет и circuit breaker

- `spec.step.budget` применяется к **каждой** реализации отдельно.
- `CircuitBreaker` срабатывает по агенту: 3 провала ollama → оставшиеся ollama-подзадачи HITL, glm-подзадачи продолжаются.

### Health-gate для fan_out-агентов

`checkHealthForAgents` сегодня собирает `uniqueAgents` из `allSteps.map(s => s.agentName)`. У fan_out-шага **нет** `agent` — есть `agents: [glm, ollama]`. Без правки ollama не попадёт в health-check и гейт «Ollama недоступен → запуск не начинается» **не сработает**. Раннер должен добавлять в `uniqueAgents` все `spec.agents` каждого `FanOutSpec`.

### Частичный успех и судьба integration-worktree

Текущий раннер бинарен: любой провал → `overallSuccess = false` → `escalated_hitl` + **удаление** integration-worktree (`removeIntegrationWorktree`), ветку оставляет для разбора. Для «мягких частичных провалов» это опасно: смерженные хорошие подзадачи живут только в integration-worktree/ветке.

- Провал/REJECT **отдельной** подзадачи **не** ставит `overallSuccess = false` — фан-аут продолжается.
- Задача `done` ⇔ все подзадачи APPROVE **и** пройдены post-шаги.
- Если хоть одна подзадача не APPROVE → `escalated_hitl`, но integration-worktree **не удаляется** (в отличие от общего пути), чтобы уже смерженные подзадачи и их ветка были доступны для ручного добора. Это исключение из строки runner.ts «при провале — cleanup integration worktree».

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
| `target_paths` подзадач пересекаются | **v1:** HITL при материализации, до запуска (нормализованные пути, parent/child). Осознанно строго — ослабляемо до merge-first, см. §«Пересечение target_paths» |
| Фактический diff вышел за `target_paths` | подзадача failed/HITL до review, candidate не создаётся |
| ollama: сетевой сбой / 5xx | ретраи в пределах `max_steps`, затем failed |
| ollama: зацикливание | `reason: no_changes`/`error`, failed |
| codex(review) REQUEST_CHANGES / REJECT | candidate удаляется, подзадача failed, fan-out продолжается |
| Circuit breaker на ollama (3 провала) | оставшиеся ollama → HITL, glm продолжаются |
| Health-gate: Ollama недоступен | запуск не начинается |

## Несостыковки с текущим кодом (чек-лист для реализующего)

Сверка дизайна с реальным `src/` на 2026-07-10. Каждый пункт — место, где наивная реализация по спеке сломается о существующий код.

| # | Место | Проблема | Решение в спеке |
|---|---|---|---|
| 1 | `blackboard.ts` `newStepId` | `#` уже разделитель итераций цикла (`S03#2`); `build#P1` коллидирует | Отдельный сегмент `~P1`/`~P1r`, схема `<base>[#iter][~sub[r]]` — см. §«Идемпотентность stepId» |
| 2 | `runner.ts` `contextFromPrevStep` | Не знает суффиксов `~P1` → downstream (`final`) получит `context=null` | Агрегат под базовым stepId — см. §«Downstream-контекст» |
| 3 | `envelope.ts` | `z.enum(["claude","codex","glm"])`, `z.enum(["anthropic","openai","zai"])` **и** `assertFamily` — три места | Добавить `ollama`/`local` во **все три**, не только в enum |
| 4 | `runner.ts` `runStep` | `createWorktree(…, step.agent)` → N ollama-подзадач = одна ветка = коллизия worktree | Суффикс подзадачи в имя ветки — см. §«Идемпотентность stepId» |
| 5 | `runner.ts` `runStep` review | review/merge в общем `integrationWtPath` + `git merge --ff-only` → гонка при параллели; безусловный merge до review неоткатываем при REJECT | Фаза A параллельно / Фаза B через disposable candidate последовательно — см. §«Параллелизм» |
| 6 | `families.ts` | `validReviewerFamilies` вернёт `local` как «валидного ревьюера» для др. семей; ollama ревьюить не умеет | `local` исключить из кандидатов в ревьюеры (only-implement семья); `pickReviewer` уже безопасен, но список кандидатов проверить |
| 7 | `workflow.ts` + `runner.ts` | `max_parallel` в двух источниках (YAML vs `RunOptions`) | Приоритет CLI > YAML > 3 — см. §«Параметр» |
| 8 | `runner.ts` health-gate | `uniqueAgents` из `s.agentName`; fan_out-шаг без `agent` → ollama не проверяется | Добавить `spec.agents` в сбор — см. §«Health-gate» |
| 9 | `runner.ts` cleanup | Любой провал → `removeIntegrationWorktree`, потеря смерженных подзадач | Не удалять при частичном провале — см. §«Частичный успех» |
| 10 | `runner.ts` parallel levels | `concurrency` вычисляется, но `Promise.all(level.map(...))` запускает весь уровень сразу | Ввести bounded helper `runBounded(items, maxParallel, fn)` и использовать для обычных parallel-levels и fan-out |
| 11 | `workflow.ts` `assertNonOverlappingPaths` | Сейчас сравнивает только точное совпадение строк, не ловит `src` vs `src/foo.ts` | Нормализовать пути и считать parent/child пересечением |
| 12 | fan-out implement | `target_paths` из плана может не соответствовать фактическому diff | После implement проверять `git diff --name-only`/status против `target_paths`; выход за область → failed/HITL |

## Тесты

Расширение `scripts/smoke*.ts`:

**Unit (без сети):**
- `families.ts`: `ollama` в `AGENTS`; `validReviewerFamilies("local")` = [anthropic, openai, zai]; `validReviewerFamilies("anthropic"|"openai"|"zai")` **не** содержит `local`.
- `plan.ts`: `parsePlan` на валидном/мусорном/пустом → ok/throw.
- `workflow.ts`: `fan_out` компилируется; без `from_plan`/`agents` — ошибка; `from_plan` ссылается вперёд — ошибка.
- Маршрутизация: complexity 85/threshold 80 → glm; 70/80 → ollama; threshold 100 → 99 идёт в ollama, 100 в glm; threshold 0 → всё в glm.
- **stepId-сегменты** (пункт №1): `~P1` и `#2` не коллидируют; парсер stepId разбирает `S02~P1r` (fan-out review) и `S03#2` (итерация) однозначно.
- **`contextFromPrevStep` для fan_out** (пункт №2): downstream-шаг с `depends_on:[build]` получает агрегат, а не `null`.
- **health-gate** (пункт №8): `uniqueAgents` включает `ollama` из `spec.agents`, даже если ни один обычный шаг его не использует.
- **max_parallel приоритет** (пункт №7): CLI перекрывает YAML.
- **bounded concurrency** (пункт №10): при 10 независимых шагов и `max_parallel=3` одновременно выполняется не больше 3.
- **path overlap** (пункт №11): `src` пересекается с `src/foo.ts`, `src/foo.ts` пересекается с `src/./foo.ts`, `src/a.ts` не пересекается с `src/b.ts`.
- **diff guard** (пункт №12): подзадача с `target_paths: ["src/a.ts"]`, изменившая `src/b.ts`, получает failed/HITL до review.
- **candidate review flow**: `REQUEST_CHANGES`/`REJECT` не продвигает integration; `APPROVE` продвигает.

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
- `src/families.ts` — семья `local`, агент `ollama`; исключить `local` из кандидатов-ревьюеров (пункт №6).
- `src/envelope.ts` — `ollama`/`local` в **обоих** enum (`agent`, `family`) **и** в `assertFamily` (пункт №3).
- `src/blackboard.ts` — `newStepId` (или новый хелпер) под сегмент `~<subtask>` (пункт №1).
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
