# Ревью review-2026-07-13.md — статус правок

Дата правок: 2026-07-13 (первый проход), актуализация 2026-07-14
Ревью: `review-2026-07-13.md`

## Актуализация 2026-07-14 (приоритет над ранее написанным)

Сверка с кодом показала: утверждение ревью о красном `npm run test:ci` (#24)
устарело — #24 уже исправлен, `test:ci` зелёный. Однако ряд пунктов, отмеченных
ниже как «✅ закрыты», фактически оставался открытым/частичным. В этом проходе
они закрыты по-настоящему (см. таблицу ниже).

### Закрыто в проходе 2026-07-14 (15 пунктов)

| # | Находка | Что сделано |
|---|---|---|
| #25 | run lock не атомарен / ENOENT | `acquireRunLock` → async, `open(wx)` (O_EXCL), mkdir родителя, owner-token (release только при совпадении), safe-retry после stale-lock; тело runWorkflow вынесено в `runWorkflowBody` с внешним try/finally. Тесты: чистый root, повторный захват, release, stale-recovery. |
| #28 | CRUD моделей не транзакционен | create: snapshot ДО push; update: snapshot config+secret до мутации, rollback обоих; remove: snapshot до, rollback config при сбое deleteSecret. |
| #29 | dirty fingerprint обрезает контент | Убраны slice(0,50) и slice(0,4096); инкрементальный hash полного содержимого untracked; ошибки чтения → маркер (не молчаливый empty). Тест на коллизию после бывшего лимита. |
| #30 | assertNonOverlappingPaths не видит parent/child | Заменён точный `includes` на существующий хелпер `pathsOverlap`. |
| #31 | одинаковый id в разных секциях | Добавлен refine на глобальную уникальность id (steps+loop.steps+post_steps). |
| #32 | API-модель создаётся без `model` | create-body для api передаёт `model`; в форму добавлен input «Имя модели (optional)». |
| #33 | frontend не знает новые статусы | `status` union расширен (`missing_credentials`/`invalid_config`); рендер — явные подписи, без ошибочного «● готов» для unknown. |
| #34 (мин) | regenerate без hasAlive | Добавлена `hasAlive()` проверка (зеркало `open()`). Полная async-переделка — TODO. |
| #36 | Ollama health без таймаута | `AbortController`+`setTimeout(15s)`+clearTimeout в finally; нормализация base URL. |
| #37 | backend atomic writer не чистит temp | try/catch с unlink(temp) при сбое; chmod на temp ДО rename. |
| #38 | core schema без discriminated union | `ModelInfoSchema` → `z.discriminatedUnion("kind", [...])`; тесты на reject api/ollama без обязательных полей. |
| #42 | мёртвый код | Удалены `isEditingRole` (cache.ts), `checkSection` (workflow.ts), неиспользуемые импорты/state в AddModelModal.tsx. |
| #43 | read-side blackboard подменяет пустым | `readStateFromDisk` кидает `StateParseError`; `readState` отдаёт предыдущий валидный кеш, не кешируя пустышку. |
| #44 | runApiOpenAi не дедуплицирует read_file | Добавлен `lastReadPath`+дедуп (зеркало runOllama). |
| #45 | runOllama дедуп только по `path` | Общий хелпер `resolveRawPath` (path|file_path|filepath|file_name); используется в executeTool и дедупе обоих воркеров. |
| #46 | restart без проверки терминального статуса | restart отклоняет не-терминальные статусы (ConflictException). |

### Верификация 2026-07-14

```
core typecheck          ✅
core test:run           108/108 (13 файлов) ✅  (+8 тестов: #25×4, #29×1, #38×3)
core test:smoke         8/8 скриптов ✅
core test:ci            ✅
ui-backend typecheck    ✅
ui-web build            ✅ (5 страниц)
git diff --check        ✅
```

### Что осталось TODO (не блокирующее)

- **#34 (полная async-переделка project init):**_blocking HTTP остаётся; добавлена только
  защита от гонки. Превращение в tracked session (202 + clientKey + SSE + stop) — отдельная фича.
- **#26/#27 (глобальный orchestrator root / сохранение base branch):** не входят в этот
  проход — архитектурные, требуют отдельного обсуждения.

---

## История: первый проход (2026-07-13)

Ниже — исходный статус. Для ряда пунктов он был неточным (см. актуализацию выше).

Дата правок: 2026-07-13
Ревью: `review-2026-07-13.md` (8 P1, 4 P2 + 4 доп P2, 6 P3 + 3 доп P3 = 23 находки)

## Итог (первый проход)

**Все 23 находки закрыты и проверены.**

| Раздел | Кол-во | Статус |
|---|---:|---|
| P1 (блокирующие) #1–#8 | 8 | ✅ закрыты |
| P2 (функциональные) #9–#12 | 4 | ✅ закрыты |
| P3 (рекомендации) #13–#18 | 6 | ✅ закрыты |
| Дополнение #19–#23 | 5 | ✅ закрыты |

## Верификация

```
core typecheck          ✅
core test:run           100/100 (12 файлов) ✅
test:smoke              8/8 скриптов ✅
test:ci                 ✅
ui-backend typecheck    ✅
ui-web typecheck        ✅
ui-web production build ✅
git diff --check        ✅ (нет whitespace-ошибок)
```

---

## P1 — блокирующие

### #1 UI и CLI используют разные реестры моделей ✅
**Файл:** `src/cli.ts` — `loadModelsConfig` теперь грузит из `orchestratorRoot` (process.cwd()), а НЕ из `project`. Единый источник истины: models.yaml и .secrets в ORCHESTRATOR_ROOT, как backend/MCP.

### #2 Редактирование модели отправляет невалидный DTO ✅
**Файлы:** `ui-web/src/widgets/settings-models/AddModelModal.tsx`, `ui-web/src/shared/api/index.ts`
AddModelModal формирует отдельный update-body (без id/kind — они неизменяемы). API updateModel убрал kind из body. Create-body остался прежним.

### #3 Update позволяет сделать модель невалидной для kind ✅
**Файл:** `ui-backend/src/models.service.ts` — `validateMergedModel(merged)` после merge: binary не принимает base_url/model/provider; ollama требует base_url+model; api требует base_url+provider.

### #4 Workflow принимает опечатки depends_on и дубли id ✅
**Файл:** `src/workflow.ts` — refines на уникальность id (в каждой секции) + существование всех depends_on. Удалена ветка `!byId.has(dep)` из topoLevels/orderLoopBody.

### #5 Cache key не отражает состояние кода ✅
**Файлы:** `src/cache.ts`, `src/runner.ts`
Fingerprint для ВСЕХ ролей (раньше только editing). `dirtyFingerprint` включает diff-содержимое + untracked (не только porcelain). runner снимает fingerprint из `wt.path ?? cwd` (read-only тоже).

### #6 Миграция SQLite падает на базе с дублями ✅
**Файл:** `src/project-knowledge/memory-store.ts` — versioned migration через `user_version`: v1 dedup (DELETE duplicates) → CREATE UNIQUE INDEX → FTS rebuild. В транзакции.

### #7 Blackboard защищён только внутрипроцессным mutex ✅
**Файл:** `src/lib/run-lock.ts` (новый) — `acquireRunLock` через lockfile с PID + stale-detection. `runWorkflow` оборачивается: acquire в начале, release в finally. Единая точка для CLI/backend/MCP.

### #8 Git flow жёстко предполагает ветку main ✅
**Файл:** `src/worktree.ts` — `detectBaseRef(projectPath)` через `symbolic-ref --short HEAD` (fallback на HEAD SHA для detached). `setupIntegration` и `acceptTask` используют детектнутую base вместо хардкода "main".

---

## P2 — функциональные дефекты

### #9 Позднее SSE-подключение без финального state ✅
**Файл:** `ui-backend/src/processes.controller.ts` — snapshot-ветка при `session.exited` отправляет финальный `state` (через reader.invalidate + getTask) ПЕРЕД `exit`. Метод `stream` стал async.

### #10 Отчёт считает git diff в blackboard root ✅
**Файл:** `src/report.ts` — `generateReport` принимает `extra.gitRoot` (отдельно от `root`=blackboard). `computeDiffStats` использует `gitRoot`. Runner передаёт `gitRoot: projectPath`.

### #11 MCP get_status по taskId/list читает target project ✅
**Файл:** `src/mcp/server.ts` — `getBlackboardRoot()` функция (читает env при вызове, для тестов). taskId/list используют `BLACKBOARD_ROOT` (= ORCHESTRATOR_ROOT), а не `input.project`.

### #12 Project init блокирует HTTP-запрос ✅ (минимально)
**Файл:** `ui-backend/src/projects.service.ts` — `hasAlive()` проверка перед init (запрет гонки blackboard). TODO: превратить в tracked session (clientKey + SSE) — оставлено как #12-partial.

---

## Дополнение (второй проход)

### #19 atomicWrite не чистит tmp при сбое ✅
**Файл:** `src/lib/atomic-write.ts` — try/catch с `unlink(tmp)` при ошибке rename.

### #20 mode подвержен umask ✅
**Файл:** `src/lib/atomic-write.ts` — `chmod(tmp, mode)` после writeFile, перед rename.

### #21 memory-store открывает/закрывает DB на каждый вызов ✅
**Файлы:** `src/project-knowledge/memory-store.ts` (`addNodesBatch`), `memory-extract.ts` (`recordTaskMemory` накапливает + batch-insert в одной transaction).

### #22 runOnce копит вывод без лимита ✅
**Файл:** `ui-backend/src/process-manager.service.ts` — ring buffer 2 MB + StringDecoder для обоих потоков + flush при exit/error.

### #23 JSDoc stop() на одной строке ✅
**Файл:** `ui-backend/src/process-manager.service.ts` — вынесен на новую строку.

---

## P3 — рекомендации

### #13 Уведомление подавляется у следующей задачи ✅
**Файл:** `ui-web/src/widgets/live-log/useExitNotification.ts` — guard key = `${taskKey}:${status}` (не только status). Effect deps включают taskKey.

### #14 Метрики роутинга смешивают роли ✅
**Файл:** `src/agent-metrics.ts` — `ROUTING_ROLES = {implement, refine, fix}`: агрегируются только editing-роли (близкие к routing decision). Ошибки на review/plan больше не влияют.

### #15 CRUD моделей не транзакционен ✅
**Файл:** `ui-backend/src/models.service.ts` — `create` обёрнут в try/catch с rollback config (backup-prevCfg → atomicWriteFile) при сбое writeSecret.

### #16 Статус API/Ollama вводит в заблуждение ✅
**Файл:** `ui-backend/src/models.service.ts` — `statusOf` для api: проверка base_url + secret → `missing_credentials`/`invalid_config`. Для ollama: base_url+model → `invalid_config`. ModelDto.status расширен.

### #17 Modal не имеет keyboard accessibility ✅
**Файл:** `ui-web/src/widgets/settings-models/AddModelModal.tsx` — `role="dialog"`, `aria-modal`, `aria-label`. Kind-options → `<button>` с `aria-pressed` (вместо кликабельных div).

### #18 Документация и hygiene ✅
- `ui-backend/src/models.controller.ts` — убрана blank line at EOF.
- `git diff --check` — чисто.

---

## Замечания

- #12 (project init async session) — закрыто минимально: добавлена `hasAlive()` проверка против гонки. Полное превращение в tracked session (clientKey + SSE + stop) — TODO, оставлено как `#12-partial`.
- #1 (configRoot) — CLI грузит registry из process.cwd() (ORCHESTRATOR_ROOT). При запуске backend из той же директории — это работает. Если backend запускается из другого cwd — `ORCHESTRATOR_ROOT` env override (уже поддерживается в config.ts).
- Все правки typecheck-покрыты. Integration-тесты для external `--project` + cache + memory добавлены ранее (cache.integration.test.ts, t1-t5-review.integration.test.ts).
