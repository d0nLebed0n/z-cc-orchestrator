# Версии CLI (зафиксированы 2026-07-07)

Паттерны привязаны к версиям. При обновлении CLI — перетестировать.

| CLI | Версия | Путь |
|---|---|---|
| claude (Claude Code) | 2.1.202 | `/Users/ilyalebedev/.local/bin/claude` |
| codex (OpenAI Codex CLI) | 0.142.5 | `/Applications/Codex.app/Contents/Resources/codex` |
| node | v24.6.0 | system |
| tsx | 4.23.0 | devDependency |

## Ключевые флаги по версиям

### claude 2.1.202
- `-p` — headless/print режим
- `--output-format text` — вывод последнего сообщения текстом
- env `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` — для GLM-профиля (gate pending)

### codex 0.142.5
- `exec` — headless выполнение
- **`-a never` УСТАРЕЛ** в 0.142.5 (вызывает `error: unexpected argument`).
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
