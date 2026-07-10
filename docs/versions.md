# Версии CLI (обновлено 2026-07-10)

Паттерны привязаны к версиям. При обновлении CLI — перетестировать.

| CLI | Версия | Путь |
|---|---|---|
| claude (Claude Code) | 2.1.202 | `/Users/ilyalebedev/.local/bin/claude` |
| codex (OpenAI Codex CLI) | 0.144.0-alpha.4 | `/Applications/ChatGPT.app/Contents/Resources/codex` |
| ollama | 0.31.2 | `http://d0nlebed0n.tail74ba62.ts.net:11434` (Tailscale) |
| node | v24.6.0 | system |
| tsx | 4.23.0 | devDependency |

> **codex путь изменился (2026-07-10):** OpenAI влил standalone `Codex.app`
> в `ChatGPT.app`. Старый путь `/Applications/Codex.app/.../codex` больше не
> существует. Дефолт в `runCodex.ts`/`health.ts` обновлён на
> `/Applications/ChatGPT.app/Contents/Resources/codex`; переопределяется env
> `CODEX_BIN` (см. `.env.local`). Версия `0.144.0-alpha.4` — проверить флаги.

## Ключевые флаги по версиям

### claude 2.1.202
- `-p` — headless/print режим
- `--output-format text` — вывод последнего сообщения текстом
- env `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` — для GLM-профиля (gate pending)

### codex 0.144.0-alpha.4 (ранее 0.142.5)
- `exec` — headless выполнение
- **`-a never` УСТАРЕЛ** ещё в 0.142.5 (вызывает `error: unexpected argument`).
  Заменён на:
  - `-s workspace-write` — sandbox-режим (писать в workspace). Для npm install
    добавить `-c sandbox_permissions='["network-access"]'` (TOML-массив).
  - `--skip-git-repo-check` — worktree может быть вне основного репо.
  - Полный bypass: `--dangerously-bypass-approvals-and-sandbox` (не используем).
- `--json` — JSONL-стриминг событий (для сигнала `turn.completed`)
- `-o`/`--output-last-message <FILE>` — sidecar-файл последнего сообщения
  (сигнал #3 успеха). Раннер читает его после завершения.
- Замечание: codex при старте логирует в stderr ошибки MCP-подключений
  (figma, chrome-devtools) — это **не фатально**, `turn.completed` приходит.
- **TODO:** проверить, не изменились ли флаги в 0.144.0-alpha.4 (alpha-версия).

### ollama 0.31.2
- Эндпоинт `/v1/chat/completions` (OpenAI-совместимый) — для `runOllama`.
- Эндпоинт `/api/tags`, `/api/version` — для health-check.
- Модель `Qwen3-Coder-30B-A3B-Instruct-1M-Unsloth:UD-IQ3_XXS` (Unsloth-квант):
  нативный `tool_calls` НЕ работает — формат уходит в `content` как
  `<tools>{...}</tools>`. `runOllama` парсит этот текстовый протокол.
