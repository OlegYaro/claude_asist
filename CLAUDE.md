# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Claude Voice Desk — Electron-приложение (macOS 26+, arm64) для голосового управления Claude Code CLI. Весь интерфейс, комментарии в коде и ответы — на русском. Подробности и найденные экспериментально ловушки — в `README.md` (разделы «Что выяснилось»): прочитай их перед правками в PTY, хуках или транскрипте.

## Команды

```bash
npm run dev         # режим разработки (electron-vite)
npm run typecheck   # tsc по tsconfig.node.json (main/preload/shared) и tsconfig.web.json (renderer)
npm run build       # build:stt (swiftc → resources/stt-helper) + electron-vite build → out/
npm run app         # сборка + установка в /Applications/Claude Voice Desk.app (закрывает запущенную копию)
npm run dist        # dmg в dist/
npm run icon        # перерисовать build/icon.icns
```

```bash
npm test                                   # node:test, Node 24 сам снимает типы с .ts
node --test src/main/telegram/bot-logic.test.ts   # один файл
```

Тесты есть только для чистой логики без Electron (`*.test.ts` рядом с модулем, импорт с расширением `.ts`). Линтера нет — проверка изменений: `npm run typecheck`, `npm test`, `npm run build`. Не запускай `npm run app` из сессии, открытой через само приложение: скрипт закрывает запущенную копию. `npm install` в postinstall пересобирает `node-pty` под Electron и чинит права (`scripts/fix-pty-perms.js`).

## Архитектура

Три процесса Electron + общий контракт:
- `src/shared/` — типы и IPC-контракт. `DeskApi` (`api.ts`) — интерфейс `window.desk`, его реализуют preload и потребляет renderer; push-каналы — `PUSH_CHANNELS` в `types.ts`. Новый IPC-метод добавляется в `api.ts`, `src/preload/index.ts` и `ipcMain.handle` в `src/main/index.ts`.
- `src/main/` — вся логика; `src/renderer/` — React без стейт-менеджера (`useSession.ts` подписывается на push-события).

Поток сессии в main:
1. `SessionManager` (`session-manager.ts`) владеет одной сессией на проект и связывает остальные части.
2. `ClaudeSession` (`claude-runtime.ts`) запускает `claude` в собственном PTY (`node-pty`) с заданным `--session-id`, `--append-system-prompt` (= `SESSION_PROTOCOL` из `protocol.ts`), `--settings` с HTTP-хуками и `--permission-mode` из настроек (`settings.permissionMode ?? 'default'` в `session-manager.ts`). Из окружения удаляются маркеры дочерней сессии из списка `INHERITED_CLAUDE_MARKERS` (`paths.ts`, включая `CLAUDECODE`) — иначе CLI молча не пишет транскрипт; новые маркеры добавлять в этот список.
3. `TerminalBridge` (`terminal-bridge.ts`) открывает Terminal.app через AppleScript, который запускает `resources/bridge.js` и подключается к PTY по Unix-сокету в `/tmp/cvd-<uid>/` (лимит пути 104 байта). Кадр: `[тег:1][длина:4 BE][данные]`, `0x00` — данные, `0x01` — управление.
4. `transcript.ts` инкрементально читает `~/.claude/projects/<папка>/<session-id>.jsonl` → события чата и «Действий». Парсер терпимый: неизвестные записи игнорируются, `isSidechain` отбрасывается.
5. `HookServer` (`hook-server.ts`) — локальный HTTP для хуков `PermissionRequest`, `PreToolUse` (matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|EnterPlanMode` — на нём держатся удержание плана и контроль правок, не сужать), `UserPromptSubmit`, `Stop`. Хуки, а не транскрипт, — источник истины о плане, отправке промта и конце хода (транскрипт пишется с задержкой).
6. `Assistant` (`assistant.ts`, самый большой и сложный файл) — конечный автомат фаз: удержание плана в хуке до «выполняй», распознавание диалогов TUI по хвосту экрана, отправка текста и Enter раздельно с подтверждением через хук, точка отката, барьер проверок по Stop-хуку (до `MAX_GATE_ROUNDS`), независимое ревью. Голосовые команды («выполняй», «стоп», «откати», «с планом»…) распознаются в `src/shared/intents.ts`.
7. Качество: `quality.ts` — определение и запуск проверок проекта, `snapshotTree` (точка отката через временный индекс git, без изменения рабочих файлов/ветки), дифф; `reviewer.ts` — синхронный `claude -p` только на чтение с JSON-схемой ответа.

Telegram-бот (`src/main/telegram/`): `TelegramBot` подписан на события `SessionManager` и шлёт фразы с телефона в `sessions.submit()` — ассистент не знает, откуда пришёл текст. Long polling через `fetch`, токен в `secrets.ts`, команды только из чата, привязанного одноразовым кодом (`settings.telegramChatId`). Чистая логика (разбор команд, код привязки, `sessionNotes` — о чём уведомлять, кнопки с привязкой к этапу) — в `bot-logic.ts` с тестами.

История (левая панель): `history.ts` ищет транскрипты проекта в `~/.claude/projects` (имя папки — подсказка, принадлежность проверяется по `cwd`), `history-logic.ts` (с тестами) сводит их в запросы с итогами. «Продолжить» — `SessionManager.start(dir, resumeId)` → `claude --resume <id>` (тот же id и файл). Старая часть транскрипта (до `historyBytes`) уходит из `TranscriptTailer` событием `history` только в чат, мимо ассистента: иначе старый план снова ждал бы одобрения.

Прочее в main: `stt.ts` — интерфейс `SttProvider`, реализация через нативный `resources/stt-helper` (Swift, `native/stt-helper/main.swift`; для `ru-RU` нужен `DictationTranscriber`, не `SpeechTranscriber`); запись WAV 16 кГц делается в renderer (`recorder.ts`, AudioWorklet). `prompt-builder.ts` — при наличии API-ключа ассистент чистит формулировку новой задачи через `@anthropic-ai/sdk` (вызывается только из `assistant.ts`, в renderer не выставлен); ключ хранится через `safeStorage` (`secrets.ts`) и никогда не передаётся в renderer. `settings.ts` — настройки в `~/Library/Application Support/claude-voice-desk`.

## Важное при изменениях

- Взаимодействие с TUI хрупкое: не слать текст и Enter одним `write`, не чистить поле через Ctrl+U, в диалоге доверия курсор по умолчанию на «No, exit», в диалоге плана вариант «1» включает авто-режим — номер «manually approve» берётся с экрана.
- Не переводить сессию в авто-режим: он сам одобряет планы и рискованные команды.
- Windows-адаптеры не реализованы; подпись — ad-hoc (после пересборки macOS может заново спросить доступ к микрофону).
