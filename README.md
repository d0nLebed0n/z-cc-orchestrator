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

## Требования

- Node.js ≥ 20 (проверено на 24.6)
- `claude` CLI (Claude Code) в PATH
- `codex` CLI — по умолчанию `/Applications/Codex.app/.../codex`, переопределяется `CODEX_BIN`
- для GLM-шагов: `GLM_BASE_URL` + `GLM_API_KEY` (после прохождения GLM-gate, см. `docs/decisions.md`)

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
- ✅ Этап 3 (YAML-воркфлоу) — 6 встроенных, включая циклический `agentic`/`thorough`
- ✅ Этап 3 (loop) — декларативные циклы в YAML с условием выхода по вердикту review
- ✅ Этап 4 (resilience) — budget cap, circuit breaker, checkpoint, worktree-merge
- ✅ Этап 5 (CLI) — `ai-task`, `--list`, `--status`, `--health`, `--accept`
- ✅ Этап 5.2 (system prompts по ролям) — plan/implement/review/refine/fix/final
- ✅ Этап 5.5 (health check) — gate перед запуском
- ✅ End-to-end — `agentic` (цикл), `thorough` (цикл+final), `default`, `ui`, `quick` + `--accept`

### Воркфлоу
**Роли ↔ агенты (жёстко):** `plan`=claude · `implement`/`fix`/`refine`=glm · `review`=codex · `final`=claude.

| Имя | Описание |
|---|---|
| `agentic` | **цикл**: claude(plan)→glm(implement)→codex(review), пока APPROVE (лимит 3) |
| `thorough` | цикл plan→impl→review + post-loop claude(final) |
| `default` | glm(implement)→codex(review) |
| `ui` | glm(implement)→codex(review) |
| `quick` | glm(implement), без review |
| `boilerplate` | glm(implement)→codex(review) |

### Известные нюансы (см. docs/decisions.md)
- codex 0.142.5: флаг `-a never` устарел → `-s workspace-write` + `--skip-git-repo-check`.
- codex `login status` пишет в **stderr** (не stdout) — health check это учитывает.
- codex `doctor` падает на TERM=dumb (headless) — не используем, заменён на `login status`.
- Review/final шаги запускаются в integration-worktree (иначе не видят код).
- Claude session-docs skill пишет артефакты в основной репо — перед `--accept` может потребоваться `git checkout -- .`.
- Цикл выходит по `VERDICT: APPROVE` (или REJECT→HITL). Лимит итераций = 3 (в YAML).
