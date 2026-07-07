# Решения и ограничения (ADR-style)

## Принятые архитектурные решения

### D-001: Оркестратор — Node/TS-раннер, не Claude
**Дата:** 2026-07-07
**Контекст:** PLAN §0. Две возможные архитектуры — A (Claude-as-orchestrator) и B (Node-раннер).
**Решение:** Вариант **B**. Раннер на Node/TypeScript владеет циклом диспатча, состоянием, бюджетом. Claude/Codex/GLM — воркеры, вызываемые headless. Claude остаётся «мозгом» на шаге `plan`, но не управляет циклом.
**Причина:** YAML-воркфлоу, budget caps, circuit breaker, checkpoint — детерминированная механика, её должен исполнять код, а не языковая модель. «Просьба к модели» стеречь бюджет — не гарантия.

### D-002: Три семьи моделей (Anthropic / OpenAI / Z.ai)
**Дата:** 2026-07-07
**Контекст:** PLAN §1. GLM запускается бинарником `claude`, но это отдельная модель Z.ai.
**Решение:** GLM считается семьёй `zai`, отдельной от `anthropic` (несмотря на общий бинарник). Правило кросс-семейного ревью: код одной семьи ревьюит другая.

### D-003: Бюджет — время + шаги, не доллары
**Дата:** 2026-07-07
**Контекст:** Все три CLI на подписках, оплата не за токен.
**Решение:** `budget: { wall_time_sec, max_steps, max_session_min? }`. Раннер стережёт, circuit breaker страхует.

### D-004: Checkpoint пишет раннер, не модель
**Дата:** 2026-07-07
**Контекст:** PLAN §4.3. Codex `/compact` ненадёжен (resume может вернуть мёртвую сессию).
**Решение:** Раннер читает вывод воркера и сам пишет digest в `.orchestrator/checkpoints/`. Свежая сессия получает его через `envelope.context`.

### D-005: Merge — последовательный, раннером; конфликт → HITL
**Дата:** 2026-07-07
**Контекст:** PLAN §4.5. Параллельные воркеры могут конфликтовать.
**Решение:** Раннер ждёт завершения всех воркеров шага, затем мержит их ветки в `integration` по одной. Конфликт → HITL-эскалация, не автопочинка. В `main` пишет только приёмка (`ai-task --accept`).

---

## Проверка окружения (Этап 0, кроме 0.0)

| Компонент | Версия | Путь / статус |
|---|---|---|
| Node.js | v24.6.0 | `node` в PATH |
| npm | 11.5.1 | в PATH |
| tsx | 4.23.0 | через npx (dev-dependency) |
| git | 2.50.1 | Apple Git-155 |
| `claude` | 2.1.202 | `/Users/ilyalebedev/.local/bin/claude` (Claude Code) |
| `codex` | 0.142.5 | `/Applications/Codex.app/Contents/Resources/codex` |

### D-006: Путь к бинарнику codex
**Дата:** 2026-07-07
**Контекст:** Codex установлен как macOS-приложение, не в PATH для headless-вызова из spawn.
**Решение:** `CODEX_BIN` по умолчанию = `/Applications/Codex.app/Contents/Resources/codex`. Переопределяется env-переменной `CODEX_BIN`. `codex` недоступен как alias в не-interactive shell (zsh alias не разворачивается в `spawn`).

---

## GLM feasibility GATE (Этап 0.0) — ✅ ПРОЙДЕН

**Дата:** 2026-07-07
**Base URL:** `https://api.z.ai/api/anthropic` (anthropic-совместимый эндпоинт Z.ai)
**Ключ:** передан пользователем, в репозиторий **не записан** (хранится вне кода,
подставляется через env `GLM_API_KEY` при запуске).

| Проверка | Статус | Результат |
|---|---|---|
| `0.0.1` Актуальный base URL Z.ai | ✅ | `https://api.z.ai/api/anthropic` — отвечает |
| `0.0.2` `claude -p` с GLM env отвечает от GLM | ✅ | exit 0, ответ получен |
| `0.0.3` Streaming не рвётся | ✅ | `--output-format stream-json` отдаёт `system`→`assistant`→`result` без обрывов |
| `0.0.4` Tool use / правка файлов через прокси | ✅ | `claude -p` создал `hello.txt` + `docs/`, `git status` непустой |
| `0.0.5` Headless `claude -p` с GLM env | ✅ | exit 0, `permissionMode: dontAsk` |

**Вердикт:** GATE ПРОЙДЕН. `run-glm` = `run-claude` + env (текущая реализация в
`src/workers/runGlm.ts` корректна). Отдельный адаптер не нужен.

### Важные наблюдения (зафиксировать)

1. **Z.ai делает прозрачный роутинг имени модели.** `claude` CLI отправляет
   `model: "claude-opus-4-8"`, но эндпоинт Z.ai мапит его на GLM и в ответе
   возвращает `"model": "glm-4.7"` (или `glm-4.6` при прямом запросе). То есть
   запрос идёт **к GLM**, несмотря на anthropic-имя модели в запросе.

2. **Self-identification ненадёжна.** `claude` CLI с Z.ai env представляется как
   «Claude Opus 4.8, Anthropic» — это системный промпт Claude Code, не реальная
   модель. Реальная модель = GLM (подтверждено raw HTTP: «trained by Z.ai»).
   **Не использовать self-id для проверки семьи** — семья определяется env
   (endpoint), а не тем, как модель себя называет.

3. **Предупреждение при запуске:** `claude` CLI печатает
   `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY…`
   Это **не ошибка** — informational, работа не блокирует. Раннеру фильтровать
   stderr по этому паттерну не нужно (exit 0, вывод корректен).

4. **`--output-format stream-json`** отдаёт `modelUsage` с именем `claude-opus-4-8`
   (что CLI отправил), но `assistant.message.model` = `glm-4.7` (что Z.ai вернул).
   Для определения реальной модели смотреть `assistant.message.model`.

### D-007: GLM-via-claude подтверждена
**Дата:** 2026-07-07
**Решение:** Тезис «GLM = второй профиль `claude` с env-подменой» — **верен**.
`run-glm` реализован как `run-claude` с `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
от Z.ai. Семья GLM = `zai` (D-002), несмотря на общий бинарник с Claude.

---

## End-to-end проверка (Этап 5.4) — ✅ ПРОЙДЕНА

**Дата:** 2026-07-07
Прогнаны три сценария на временных git-репозиториях:

| Сценарий | Воркфлоу | Агенты | Результат |
|---|---|---|---|
| E2E #1-3 | `ui` | claude(implement) → codex(review) | ✅ multiply добавлена, оба шага success |
| E2E #4 | `ui` | claude → codex | ✅ main нетронут, изменения в integration |
| E2E #5 | `quick` | glm(implement) | ✅ VERSION добавлена, accept в main |
| `--accept` | — | — | ✅ fast-forward main → integration |

**Полный цикл работает:** `ai-task` → раннер → worktree → воркер → commit →
merge в integration → blackboard → `--accept` → main обновлён.

### Найденные и исправленные баги при E2E

1. **`-a never` устарел в codex 0.142.5** — заменён на `-s workspace-write` +
   `--skip-git-repo-check` + `-o/--output-last-message` (см. `docs/versions.md`).
2. **`git worktree add --detach`** — коммиты воркера терялись (detached HEAD).
   Исправлено: worktree отслеживает ветку (без `--detach`).
3. **Воркеры не коммитят сами** — добавлен `commitAllInWorktree` в раннере:
   раннер коммитит все правки перед merge, иначе они теряются при worktree remove.
4. **`git checkout integration` в основном репо** — ломал рабочий каталог
   пользователя. Исправлено: integration живёт в **собственном worktree**,
   основной репо не трогается до `--accept`.
5. **`--accept` через `git branch -f`** — отказывал (branch checked out в
   worktree). Исправлено: `acceptTask` делает честный `checkout` + `merge --ff-only`
   в основном репо (это явное действие пользователя).

### Известные нюансы (не блокирующие)

- **Claude session-docs skill** пишет артефакты (`docs/prompt-docs/`) в **основной**
  репо, а не в worktree — резолвит проект по абсолютному пути. Раннер коммитит их
  в integration-ветку (как часть правок). При необходимости — добавить
  `docs/prompt-docs/` в `.gitignore` целевого проекта или отключить skill.
- **GLM в `quick`** может менять порядок/форматирование существующего кода
  (без review это ожидаемо — §3.2). Для кода в `main` обязателен ручной просмотр.
- **Working tree после прогона** может быть «грязным» (см. выше про session-docs).
  Перед `--accept` рекомендуется `git checkout -- .` если есть незакоммиченные
  изменения.

---

## System prompts по ролям (Этап 5.2) — ✅ реализовано

**Дата:** 2026-07-07
Вдохновлено `prompts/system_prompts.py` из AI-Agents-Orchestrator, адаптировано
под наши роли и стек (TypeScript, 3 агента, worktree).

`src/prompts/roles.ts`:
- `systemPromptFor(role, agent, family)` — system prompt по роли
  (plan/implement/review/refine/fix/final).
- `buildWorkerPrompt(...)` — собирает финальный промпт: `system + context + task`.
- Каждая роль имеет: impersonation агента (GLM ≠ Claude), hard constraints
  (worktree, target_paths, atomic commits), критерий завершения, output format,
  failure modes (без clarification-циклов — воркер stateless).

E2E подтвердил: вывод воркеров стал структурированным (VERDICT: APPROVE,
Blockers, files changed, commit hash) вместо свободного текста.

## Health check (Этап 5.5) — ✅ реализовано

**Дата:** 2026-07-07
Вдохновлено `health_check` из base.py адаптеров AI-Agents-Orchestrator.

`src/workers/health.ts` + `ai-task --health`:
- **claude**: binary_available + version_runs + auth_and_responds (пробный `-p`).
- **codex**: binary_available + version_runs + `login status` (не `doctor` —
  тот падает на TERM=dumb в headless, false positive; `login status` пишет
  результат в **stderr**, учтено).
- **glm**: env_credentials (GLM_BASE_URL/GLM_API_KEY) + claude_binary + glm_responds.

Раннер вызывает `checkHealthForAgents()` **до создания задачи** — gate. Если
хоть один агент unhealthy, раннер не стартует и выводит отчёт.

## Баг: review не видел код (E2E #6) — ✅ исправлено

**Дата:** 2026-07-07
**Симптом:** codex review на шаге `ui`-воркфлоу сообщил «subtract не добавлен»,
хотя в integration-ветке он был. Claude implement работал в своём worktree и
закоммитил, но codex review запускался в `projectPath` (основной репо = main,
без изменений).

**Причина:** `runStep` ставил `cwd = projectPath` для ролей review/final —
они не видели integration-ветку.

**Исправление:** review/final запускаются в `integrationWtPath` (worktree
integration-ветки, где HEAD = integration и смерженные коммиты видны).
Перед запуском — `git merge --ff-only integration` для актуальности.
implement/refine/fix — как прежде, в собственных worktree-ах.

E2E #7 (ui) и #8 (default, полный цикл codex→claude→codex) подтвердили:
review видит код, выдаёт корректный APPROVE/REQUEST_CHANGES.

---

## Циклические воркфлоу с условием выхода (loop) — ✅ реализовано

**Дата:** 2026-07-07

### D-008: Декларативный `loop` в YAML
**Контекст:** нужен цикл `claude(plan) → glm(implement) → codex(review)` с
повтором пока codex не даст APPROVE. Линейный DAG (через `depends_on`) циклы
запрещает — `topoLevels` бросает `cyclic dependency`.
**Решение:** отдельная конструкция `loop` в схеме воркфлоу (не через depends_on):
```yaml
loop:
  steps: [...]        # тело цикла (последовательный порядок по depends_on внутри)
  exit_on: <step-id>  # чей вердикт проверяем (роль review/final)
  max_iterations: 3
  on_exhausted: hitl  # hitl | accept
```
Плюс `post_steps` — линейные шаги ПОСЛЕ цикла (напр. final).
`buildLoadedWorkflow` возвращает `preLevels` + `loopBody` + `postLevels`.

### D-009: Условие выхода по вердикту
**Решение:** раннер парсит `VERDICT: APPROVE|REQUEST_CHANGES|REJECT` из output
шага `exit_on` (формат зафиксирован в `src/prompts/roles.ts`):
- `APPROVE`/`ACCEPT` → выход из цикла.
- `REJECT` → HITL-эскалация, остановка.
- `REQUEST_CHANGES` → следующий круг (контекст review → plan).
- не распарсился → трактуем как REQUEST_CHANGES (безопасно) + warning в лог.

### D-010: Итерации не перетирают историю
`newStepId(taskId, n, iteration)` добавляет суффикс `#N` при iteration > 1:
`T-XXXX-S03#2.json`. Каждый круг цикла пишет отдельный файл результата,
история вердиктов сохраняется в blackboard.

### D-011: Контекст review → plan на следующем круге
На итерации > 1 шаг `plan` получает `contextOverride` — output review-шага
прошлой итерации. Промпт `plan` явно инструктирован: при наличии в CONTEXT
`VERDICT: REQUEST_CHANGES` + `### Blockers` — адресовать каждый Blocker, а не
перепланировать с нуля.

### D-012: Правящие роли во всех воркфлоу → glm
Все правящие роли (implement/refine/fix) в существующих воркфлоу заменены на
`agent: glm` (дешёвый объём). plan/review/final остались claude/codex для
качества суждения. Кросс-семейность сохранена (glm=zai ≠ claude=anthropic ≠
codex=openai).

### Найденные и исправленные баги при E2E циклов
1. **`contextFromPrevStep` вызывался с `allSteps = []`** — контекст между шагами
   вообще не доходил (старый баг, не связанный с циклом). Починено: передаётся
   полный список шагов. Без этого цикл был бы «слепым».
2. **`default` с refine падал на `no_changes`** — после APPROVE шагу refine
   нечего править, сигнал `files_changed: no` → fail. Решение: `default`
   упрощён до `implement → review` (без refine); для цикла правок использовать
   `agentic`/`thorough`.
3. **`thorough`: final исполнялся ДО loop** — final лежал в `steps` (pre-loop),
   не в `post_steps`. Исправлено: `post_steps` вынесен отдельно, исполняется
   после выхода из цикла.

### E2E-подтверждение
- `agentic` (цикл plan→implement→review): APPROVE на итерации 1, выход. ✅
- `thorough` (loop + post-loop final): цикл → APPROVE → final. ✅
- `default` (glm implement → claude review): без цикла, упрощён. ✅
- Smoke-тест `smoke-loop.ts`: парсер вердикта (5 случаев) + stepId с итерацией. ✅

