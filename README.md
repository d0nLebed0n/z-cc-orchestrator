# z-cc-orchestrator

Оркестрация трёх AI-CLI (Claude Pro, Codex Pro, Z.ai GLM Max) единым
Node/TypeScript-раннером. Раннер владеет циклом диспатча, состоянием и
бюджетом; Claude/Codex/GLM — headless-воркеры на шагах воркфлоу.

Полный план — в [`PLAN.md`](./PLAN.md). Решения — в [`docs/decisions.md`](./docs/decisions.md).

## Быстрый старт

```bash
# установить зависимости
npm install

# список воркфлоу
npx tsx src/cli.ts --list

# запустить задачу (дефолтный воркфлоу, текущая директория как проект)
npx tsx src/cli.ts "добавь пагинацию в список пользователей" --workflow default --project ~/work/my-app

# состояние
npx tsx src/cli.ts --status

# приёмка (merge integration → main целевого проекта)
npx tsx src/cli.ts --accept <task-id> --project ~/work/my-app
```

## Веб-панель

Вместо консоли можно работать через локальную веб-панель: вводишь промт, выбираешь
воркфлоу, следишь за выполнением в реальном времени и принимаешь результат одной кнопкой.

```bash
# собрать зависимости UI (первый раз)
npm install        # корень
cd ui-backend && npm install && cd ..
cd ui-web && npm install && cd ..

# проверить, что все агенты готовы (claude/codex/glm залогинены)
npm run ui:health

# поднять панель и открыть браузер автоматически
npm run ui:full
```

Открывается `http://localhost:3000`:

- **Форма запуска** — промт + выбор воркфлоу (`default`/`agentic`/`thorough`/`ui`/`quick`/`boilerplate`) + путь к целевому проекту.
- **Живой лог** — статус шагов (`plan`/`implement`/`review`…) и построчный вывод воркеров в реальном времени; кнопки «Остановить» и «Принять (merge)».
- **История задач** — список прошлых запусков из `.orchestrator/state.json`.

**Независимый запуск частей** (для отладки):
```bash
npm run ui:backend   # только NestJS на :8080
npm run ui:web       # только Next.js на :3000
npm run ui           # оба без авто-открытия браузера
```

Панель работает поверх того же CLI: бэкенд (`ui-backend/`) запускает `tsx src/cli.ts`
как subprocess и читает `.orchestrator/state.json`, поэтому консоль и веб взаимозаменяемы.


## Требования

- Node.js ≥ 20 (проверено на 24.6)
- `claude` CLI (Claude Code) в PATH
- `codex` CLI — по умолчанию `/Applications/ChatGPT.app/Contents/Resources/codex` (OpenAI merged Codex.app в ChatGPT.app), переопределяется `CODEX_BIN`
- для GLM-шагов: `GLM_BASE_URL` + `GLM_API_KEY` (после прохождения GLM-gate, см. `docs/decisions.md`)
- для ollama-шагов (воркфлоу `decomposed`): `OLLAMA_BASE_URL` + `OLLAMA_MODEL` — локальный Ollama (проверено на 0.31.2, Qwen3-Coder-30B)

## Структура

```
src/
├── cli.ts          # точка входа ai-task
├── runner.ts       # ОРКЕСТРАТОР: граф шагов, цикл, бюджет
├── workflow.ts     # схема YAML, топосорт, кросс-семейная валидация
├── envelope.ts     # task-envelope (zod)
├── families.ts     # семьи моделей, выбор ревьюера
├── blackboard.ts   # state.json, results/, checkpoints/, log/
├── resilience.ts   # budget cap, circuit breaker, checkpoint, HITL
├── worktree.ts     # git worktrees, merge, accept
└── workers/        # runClaude / runCodex / runGlm (headless)
workflows/          # default / quick / thorough / ui / boilerplate
```

## Проверки

```bash
npx tsc --noEmit          # typecheck
npx tsx scripts/smoke.ts  # валидация воркфлоу + кросс-семейность
npx tsx scripts/smoke-units.ts  # unit-проверки семей/envelope/budget
```

## Статус

- ✅ Этап 0.0 (GLM-gate) — ПРОЙДЕН
- ✅ Этап 2 (скелет) — выполнен
- ✅ Этап 3 (YAML-воркфлоу) — 7 встроенных, включая циклический `agentic`/`thorough` и `decomposed` (fan-out)
- ✅ Этап 3 (loop) — декларативные циклы в YAML с условием выхода по вердикту review
- ✅ Этап 4 (resilience) — budget cap, circuit breaker, checkpoint, worktree-merge
- ✅ Этап 5 (CLI) — `ai-task`, `--list`, `--status`, `--health`, `--accept`, `--max-parallel`
- ✅ Этап 5.2 (system prompts по ролям) — plan/implement/review/refine/fix/final
- ✅ Этап 5.5 (health check) — gate перед запуском (4 агента: claude/codex/glm/ollama)
- ✅ End-to-end — `agentic` (цикл), `thorough` (цикл+final), `default`, `ui`, `quick` + `--accept`
- ✅ **Локальный исполнитель (Ollama) + fan-out** — 4-я семья `local`/агент `ollama`;
  воркфлоу `decomposed`: claude(plan, декомпозиция) → fan-out на glm(сложное)/ollama(тривиальное)
  по `complexity_threshold` → codex(review) на каждую → claude(final). Двухфазный merge
  (параллельный implement + последовательный candidate review). **E2E доказан с реальными моделями.**

### Воркфлоу
**Роли ↔ агенты:** `plan`/`final`=claude · `implement`/`fix`/`refine`=glm или ollama · `review`=codex.
Четыре семьи: anthropic / openai / zai / local. Кросс-семейное ревью обязательно.

| Имя | Описание |
|---|---|
| `decomposed` | **fan-out**: claude(plan) → N подзадач (glm сложные / ollama тривиальные по threshold) → codex(review) → claude(final) |
| `agentic` | **цикл**: claude(plan)→glm(implement)→codex(review), пока APPROVE (лимит 3) |
| `thorough` | цикл plan→impl→review + post-loop claude(final) |
| `default` | glm(implement)→codex(review) |
| `ui` | glm(implement)→codex(review) |
| `quick` | glm(implement), без review |
| `boilerplate` | glm(implement)→codex(review) |

### Известные нюансы (см. docs/decisions.md)
- codex 0.144.0-alpha.4: OpenAI влил Codex.app в ChatGPT.app — путь `/Applications/ChatGPT.app/.../codex` (переопределяется `CODEX_BIN`).
- codex: флаг `-a never` устарел → `-s workspace-write` + `--skip-git-repo-check`.
- codex `login status` пишет в **stderr** (не stdout) — health check это учитывает.
- ollama (Qwen3-Coder-30B Unsloth-квант): нативный tool_calls НЕ работает — модель встраивает `<tools>{...}</tools>` в content (иногда markdown/JS-call формат). `runOllama` парсит все варианты + нормализует multi-line content.
- Review/final шаги запускаются в integration-worktree (иначе не видят код).
- Claude session-docs skill пишет артефакты в основной репо — перед `--accept` может потребоваться `git checkout -- .`.
- Цикл выходит по `VERDICT: APPROVE` (или REJECT→HITL). Лимит итераций = 3 (в YAML).
- Запись state.json сериализована через async-mutex (параллельные шаги не теряют записи).
