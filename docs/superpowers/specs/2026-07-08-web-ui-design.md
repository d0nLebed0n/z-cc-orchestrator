# Спецификация: Веб-панель для z-cc-orchestrator

**Дата:** 2026-07-08
**Статус:** Draft
**Автор:** lebedev (brainstormed with ZCode)

## 1. Постановка задачи

`z-cc-orchestrator` управляется из консоли через `ai-task "промт" --workflow <name> --project <path>`. Это неудобно: надо помнить флаги, нет живого отображения хода выполнения, история задач доступна только через `--status`. Нужна локальная веб-панель, где можно ввести промт, выбрать воркфлоу и следить за выполнением в реальном времени.

## 2. Цели и не-цели

### Цели
- Запуск задачи из формы (промт + воркфлоу + путь проекта) одной кнопкой.
- Живой лог выполнения: stdout/stderr subprocess + статус шагов.
- История задач из `.orchestrator/state.json` с деталями (шаги, результаты).
- Управление из UI: «Остановить» текущую задачу, «Принять» (merge) завершённую.

### Не-цели (YAGNI)
- Аутентификация — локальный инструмент одного разработчика.
- База данных — `state.json` уже источник истины, дублировать не нужно.
- Редактирование воркфлоу в UI — только выбор существующих YAML.
- Persistent process manager (PM2/очереди) — один пользователь, in-memory достаточно.
- Запуск нескольких задач параллельно — одна активная задача за раз (как и консоль).

## 3. Архитектура

### 3.1. Размещение в репозитории

Два новых пакета рядом с существующим кодом, без реструктуризации раннера:

```
z-cc-orchestrator/
├── src/                  # существующий оркестратор (НЕ трогаем)
├── workflows/            # существует — читаем Nest-ом
├── .orchestrator/        # существует — читаем Nest-ом
├── package.json          # расширим скриптами запуска UI
├── ui-backend/           # НОВОЕ — NestJS
│   ├── package.json
│   └── src/
└── ui-web/               # НОВОЕ — Next.js (App Router + FSD)
    ├── package.json
    ├── app/
    └── src/
```

### 3.2. Компоненты и потоки данных

```
┌─────────────────┐   HTTP/SSE    ┌──────────────────┐  subprocess   ┌──────────────────┐
│  Next.js (FSD)  │ ◄──────────►  │     NestJS       │ ───────────►  │  ai-task CLI     │
│  localhost:3000 │               │  localhost:3001  │               │  (tsx src/cli.ts)│
└─────────────────┘               └──────────────────┘               └──────────────────┘
                                          │ reads                              │ writes
                                          ▼                                     ▼
                                  .orchestrator/state.json, results/, log/
```

**Принцип интеграции:** Nest НЕ импортирует TS-код раннера. Он запускает `ai-task` как дочерний процесс и читает `.orchestrator/state.json` как внешний файл. Это развязка — оркестратор остаётся CLI-first, UI — отдельный слой поверх него. Обновление TS-кода раннера не затрагивает UI, пока сохраняется контракт `state.json` и вывод раннера.

### 3.3. Контракты данных

Все типы Nest и Next зеркалируют существующие интерфейсы из `src/blackboard.ts` (не импортируют их, а дублируют определение, чтобы сохранить развязку слоёв):

- `TaskRecord` — `{ id, prompt, workflow, project, status, integration_branch, created_at, updated_at, steps[] }`
- `StepRecord` — `{ id, task_id, agent, family, role, status, started_at, finished_at, attempts, result_path, error }`
- `TaskStatus` = `pending | running | done | failed | escalated_hitl`
- `StepStatus` = `pending | running | success | failed | escalated_hitl`

## 4. Backend (NestJS) — `ui-backend/`

### 4.1. Модули

| Модуль | Маршруты | Ответственность |
|---|---|---|
| `WorkflowsModule` | `GET /workflows` | Чтение `workflows/*.yaml`, парсинг через `yaml` (уже dep), отдаёт `{ name, description, steps[] }` |
| `TasksModule` | `GET /tasks`, `GET /tasks/:id`, `GET /tasks/:id/steps/:stepId/result` | Чтение `.orchestrator/state.json` и sidecar-файлов из `results/`. История, детали задач и результаты шагов |
| `ProcessModule` | `POST /tasks`, `POST /tasks/:id/stop`, `GET /tasks/:id/stream` | Запуск subprocess, остановка, **SSE**-стрим вывода |
| `AcceptModule` | `POST /tasks/:id/accept` | Запуск `ai-task --accept <id> --project <path>` |

### 4.2. Process Manager (ядро живого лога)

In-memory реестр активных процессов: `Map<taskId, ChildProcess>`.

**Запуск (`POST /tasks`):**
1. Валидация тела: `{ prompt: string, workflow: string, project?: string }`.
2. `spawn('npx', ['tsx', 'src/cli.ts', prompt, '--workflow', workflow, '--project', project ?? cwd], { cwd: orchestratorRoot, stdio: ['ignore','pipe','pipe'] })`.
3. При первом появлении строки `task T-XXXXXX` в stdout — извлечь `taskId`, зарегистрировать в `Map`.
4. Запомнить PID, пока не сопоставлен `taskId` (короткое окно между spawn и первой строкой раннера).

**SSE-стрим (`GET /tasks/:id/stream`):**
- `Content-Type: text/event-stream`.
- Стримит события:
  - `{ type: 'log', stream: 'stdout'|'stderr', line }` — построчно из subprocess.
  - `{ type: 'task-id', id }` — когда Nest сопоставил subprocess с реальным `taskId`.
  - `{ type: 'state', task }` — периодически (poll каждые 1–2 с) шлёт снимок `TaskRecord` из `state.json`, чтобы фронт видел прогресс шагов без отдельного поллинга.
  - `{ type: 'exit', code, success }` — завершение subprocess.
- Браузер при разрыве сам переподключается (EventSource); Nest хранит буфер последних N строк на случай переподключения.

**Остановка (`POST /tasks/:id/stop`):**
- `childProcess.kill('SIGTERM')` по `taskId` из `Map`.
- Graceful: SIGTERM даёт раннеру шанс сохранить состояние. Если процесс не вышел за 10 с — SIGKILL.

### 4.3. Accept

`POST /tasks/:id/accept` → spawn `ai-task --accept <id> --project <project>` (project берётся из `state.json` для этой задачи). Возвращает `{ ok, message }`.

### 4.4. Чтение state.json

Один сервис `BlackboardReader`:
- `readState(): Promise<BlackboardState>` — чтение+парсинг `state.json`.
- `getTask(id)`, `listTasks()`, `latestTasks(limit)`.
- Кеширование с коротким TTL (1 с) — `state.json` переписывается целиком при каждом шаге, частые перечитывания избыточны.

### 4.5. Конфигурация

- Порт: `3001` (через `PORT` env, дефолт 3001).
- `ORCHESTRATOR_ROOT` — путь к корню `z-cc-orchestrator` (дефолт: `process.cwd()` родителя, т.е. `../` от `ui-backend/`).
- CORS на `http://localhost:3000`.

## 5. Frontend (Next.js + FSD) — `ui-web/`

### 5.1. Структура FSD

```
ui-web/
├── app/                    # App Router — тонкие точки входа
│   ├── layout.tsx
│   └── page.tsx            # рендерит <DashboardWidget/>
├── src/
│   ├── app/                # глобальный setup: провайдеры, конфиг
│   │   └── config.ts       # API_BASE_URL = localhost:3001
│   ├── widgets/
│   │   ├── run-form/       # форма запуска
│   │   ├── live-log/       # живой вывод + шаги + кнопки управления
│   │   ├── task-list/      # история
│   │   └── task-detail/    # детали выбранной задачи
│   ├── features/
│   │   ├── run-task/       # usecase + хук useRunTask
│   │   ├── stream-task/    # useStreamTask (EventSource)
│   │   ├── stop-task/      # useStopTask
│   │   └── accept-task/    # useAcceptTask
│   ├── entities/
│   │   ├── task/           # типы TaskRecord/StepRecord (зеркало blackboard.ts)
│   │   └── workflow/       # тип Workflow + массив шагов
│   └── shared/
│       ├── api/            # fetch-обёртки над Nest REST
│       ├── lib/            # утилиты (форматирование времени и т.п.)
│       └── ui/             # базовые компоненты (Button, Select, Badge)
```

**Правило импортов FSD:** слой импортирует только из нижележащего (`widgets → features → entities → shared`). `app/page.tsx` (App Router) импортирует только из `widgets`. Циклы запрещены.

### 5.2. Слои и ответственность

- **entities** — чистые типы + простые селекторы (напр. `stepProgress(task)` → `success/total`). Никакой бизнес-логики, никаких API-вызовов.
- **features** — конкретные действия над сущностями. Каждый feature = один usecase: `run-task` (POST /tasks + триггерит стрим), `stream-task` (EventSource), `stop-task`, `accept-task`. Экспортируют хуки.
- **widgets** — композиция features + entities в самодостаточные блоки UI. `run-form` собирает форму, `live-log` подписывается на SSE и показывает шаги + лог + кнопки.
- **app** (FSD) — глобальный конфиг и провайдеры (контекст текущей задачи, query-клиент если понадобится).

### 5.3. Виджеты — что внутри

**`run-form`:**
- Текстовое поле промта (многострочное).
- `<select>` воркфлоу — грузит список с `GET /workflows` при маунте.
- Поле пути проекта (дефолт — текущий `process.cwd()`, в котором запущен UI; пользователь переопределяет вручную).
- Кнопка «Запустить» → `POST /tasks` → выставляет `activeTaskId` в общий стейт → `live-log` начинает стрим.

**`live-log`:**
- Шапка: `taskId`, бейдж статуса, прогресс шагов (`● plan(claude)  ● implement(glm)  ◐ review(codex)` — заполненные/текущие/ожидание).
- Тело: авто-прокручиваемый лог stdout/stderr из SSE-событий `log`.
- Кнопки: «Остановить» (`POST /tasks/:id/stop`) — активна пока subprocess жив; «Принять» (`POST /tasks/:id/accept`) — активна при `status === 'done'`.

**`task-list`:**
- Таблица последних N задач: `id`, статус (цветной бейдж), воркфлоу, прогресс шагов `ok/total`, начало промта.
- Клик строки → `task-detail`.

**`task-detail`:**
- Полный промт, метаданные.
- Список шагов: агент/роль/статус/время/`error` если есть.
- При клике на шаг — показать содержимое `result_path` (через `GET /tasks/:id/steps/:stepId/result` — доп. маршрут Nest, читает sidecar из `results/`).

### 5.4. Состояние

Минимально: один общий «активный taskId» (контекст или zustand-стор на 1 объект). Список задач и детали — через React Query (или простые `useEffect+fetch` если без доп.зависимостей). Стрим — через `useStreamTask(taskId)`, который открывает EventSource и накапливает строки в локальный стейт.

### 5.5. Конфигурация

- Порт: `3000` (дефолт Next).
- `NEXT_PUBLIC_API_URL` = `http://localhost:3001` (build-time env).

## 6. Скрипты запуска

Корневой `package.json` дополняется:

```json
{
  "scripts": {
    "ui:backend": "cd ui-backend && npm run start:dev",
    "ui:web": "cd ui-web && npm run dev",
    "ui": "concurrently \"npm:ui:backend\" \"npm:ui:web\""
  }
}
```

`concurrently` добавляется в корневой `devDependencies`. Запуск одной командой: `npm run ui`.

## 7. Обработка ошибок и крайние случаи

| Случай | Поведение |
|---|---|
| Subprocess упал (код ≠ 0) | SSE-событие `exit` с `success: false`; фронт показывает бейдж `failed` |
| Раннер ушёл в HITL (`escalated_hitl`) | Статус задачи в `state.json` = `escalated_hitl`; фронт показывает бейдж «требует внимания», кнопка «Принять» скрыта |
| Браузер переподключился к SSE | Nest хранит буфер последних ~200 строк на активный процесс, отдаёт при новом подключении, потом стримит далее |
| Nest перезапущен во время задачи | In-memory `Map` потерян → процесс остаётся «осиротевшим». На старте Nest сканирует `state.json`: если есть задача `running`, но PID не в `Map` — помечает её `failed` с пометкой «orphaned by server restart». Subprocess к этому моменту обычно уже завершился сам (SIGTERM не приходит, процесс живёт свой цикл). |
| Два запуска подряд | Перед запуском проверяем: если в `Map` уже есть живой subprocess — отклоняем с `409 Conflict`, предлагаем остановить текущий |
| `workflows/` пуст или `state.json` повреждён | REST-эндпоинт возвращает пустой список / ошибку 500 с понятным сообщением |
| Долгий вывод воркера | Лог на фронтенде ограничивается последними ~5000 строками (виртуализированный список), старые выбрасываются |

## 8. Зависимости

### Backend (`ui-backend/package.json`)
- `@nestjs/{core,common,platform-express}` — фреймворк
- `yaml` — парсинг воркфлоу (версия как в корне)
- `rxjs`, `reflect-metadata` — зависимости Nest
- dev: `@nestjs/cli`, `typescript`, `tsx`

### Frontend (`ui-web/package.json`)
- `next` (App Router), `react`, `react-dom`
- `@tanstack/react-query` — кеширование запросов списка задач
- dev: `typescript`, `@types/react`

### Корень
- `concurrently` (devDependency) — параллельный запуск двух серверов

Стек соответствует окружению проекта: Node ≥ 20, TypeScript. Новых рантаймов не появляется.

## 9. Проверка и приёмка

Ручной smoke-тест (без автоматизированных e2e на первом этапе):

1. `npm run ui` поднимает оба сервера без ошибок.
2. На `localhost:3000` открывается панель, список воркфлоу заполнен.
3. Ввести промт, выбрать `quick` воркфлоу, нажать «Запустить» — в логе виден вывод, шаг переходит `running → success`.
4. Задача появляется в истории с корректным статусом.
5. «Остановить» на активной задаче убивает subprocess (проверить по `ps`).
6. На задаче в статусе `done` кнопка «Принять» выполняет merge (проверить в целевом репо).

Typecheck: `npm run typecheck` в обоих пакетах должен проходить.

## 10. Открытые вопросы (на ревью)

1. **Один активный процесс за раз** — принято ограничение. Подходит?
2. **Polling `state.json` каждые 1–2 с** для прогресса шагов в SSE — приемлемо, или стоит читать файл только по событию новой строки в subprocess? (Polling проще и надёжнее для прогресса шагов, который не обязательно отражается в stdout.)
3. **Цветовая схема / визуальный стиль** — не определён. По умолчанию: тёмная тема, моноширинный шрифт для лога, минимализм. Уточнить?
