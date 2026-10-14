# Claude Voice Desk

[English](README.md) · [Русский](README.ru.md)

**Control [Claude Code](https://docs.claude.com/en/docs/claude-code) with your voice.** A native-feeling macOS desktop app that wraps the Claude Code CLI: you talk, it transcribes locally, Claude plans and works, and the app makes sure "done" actually means *checked*.

![macOS 26+](https://img.shields.io/badge/macOS-26%2B-black) ![Apple Silicon](https://img.shields.io/badge/arch-arm64-blue) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Why this exists

Claude Code is a great terminal tool, but typing long, precise prompts is slow, and watching a TUI scroll by is a poor way to stay in control of what an agent is doing to your code. Claude Voice Desk exists to fix three things:

1. **Talking is faster than typing.** Dictate a rambling request; Claude figures out what you mean. Speech recognition runs fully on-device through the macOS Speech framework: no cloud, no API key, no model downloads.
2. **You should see what the agent does, not scroll for it.** Actions (edits, commands, reads, permissions, checks, reviews) are grouped by task with icons, filters and colored diffs, next to a clean chat. The real Terminal.app window stays available, and you can step in by hand at any time.
3. **"Done" should mean verified.** The app runs your project's checks and an independent code review before a task counts as finished, keeps a one-click rollback point, and holds risky commands until you say yes.

It is built for people who want to drive an AI coding agent hands-free (or from a phone) without giving up safety.

## Features

- **Voice in, voice out.** Always-on microphone with auto-send after a pause. Replies are read aloud; speaking interrupts them (with echo filtering so the app does not hear itself).
- **Claude decides how to work.** A question gets an answer. A small fix is done immediately. A hard task enters plan mode, and the plan is shown in full and held until you say "go" ("выполняй" in Russian). Say "with a plan" or "just do it" to override.
- **Quality gate.** On a task with edits, the app runs your project's checks (typecheck, linter, tests from `package.json`, pytest/ruff/mypy, cargo, go). Failures go back to Claude to fix, up to three rounds. A separate read-only `claude -p` run then reviews the diff against a JSON schema.
- **Rollback.** A restore point is taken before the first edit using a temporary git index, so your working files, index and branch are never touched. "Roll back" returns the project to its pre-task state.
- **Safe approvals.** Claude runs in normal permission mode, never auto mode (which approves plans and risky commands by itself). Dangerous commands (`rm -rf`, `sudo`, `git push --force`, ...) always wait for your confirmation.
- **Model routing.** Optional auto mode runs the session on `opusplan`; the plan assigns each step to Haiku, Sonnet, Opus or Fable, steps run as subagents on those models, and a completeness check escalates unfinished steps to a stronger model. Or pin one model manually.
- **Project panel.** Current plan and status, files changed with +/- and diffs, check and review results, detected stack and commands, and CLAUDE.md notes.
- **History.** Browse past requests with outcomes and resume a previous session.
- **Telegram remote control.** Send tasks, approve plans, answer Claude's questions and confirm risky commands from your phone, including voice messages (transcribed locally).
- **Optional prompt cleanup.** With an Anthropic API key, a rambling spoken request is rewritten into a crisp prompt before it is sent. Without a key, your words go to Claude as-is.
- **Privacy by design.** Tokens and keys are encrypted with macOS `safeStorage` and never reach the UI process. The app writes nothing into your project except git commits (and those can be turned off).

## Requirements

- Mac with Apple Silicon (arm64 only).
- macOS 26 or later (needed for the Speech framework's on-device recognition).
- Xcode Command Line Tools: `xcode-select --install` (required at `npm install` to rebuild `node-pty` and to compile the Swift speech helper with `swiftc`).
- Node.js 22.18+ (24 recommended; there is an `.nvmrc`).
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` must run in your terminal). The app finds it through a login shell, or you can set the path in settings.

## Install

```bash
git clone https://github.com/OlegYaro/claude_asist.git
cd claude_asist
npm install
npm run app       # builds, packages and installs into /Applications
```

Then launch **Claude Voice Desk** from Applications. On first run macOS asks for microphone access and for permission to control Terminal.app (*Privacy & Security → Automation*). Without the latter the terminal window will not open; the app shows a command you can paste to attach manually.

The build is ad-hoc signed, so it only runs on the Mac that built it. A DMG from another machine will be blocked by Gatekeeper, so everyone installs from source. After a rebuild macOS may ask for microphone access again.

Development:

```bash
npm run build:stt   # once: compile the native speech helper
npm run dev         # run in development mode
npm run dist        # produce a DMG in dist/
npm run typecheck && npm test
```

## Usage

1. Open a project folder. Claude Code starts in it (it will ask to trust unfamiliar folders; answer in the Terminal window).
2. Talk. Your words are appended to the input and sent after a pause (3 s by default).
3. Review the plan if there is one, then say "go" to run it, "stop" to cancel, or anything else to give feedback.
4. Watch the Actions panel. When the work finishes, checks and review run automatically; say "roll back" to undo the task.

Voice commands are Russian by default (the UI, replies and command words are in Russian); the speech engine and protocol live in `src/main/stt.ts`, `src/main/protocol.ts` and `src/shared/intents.ts` if you want to adapt them to another language.

## Telegram control

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. In app settings, *Remote control*, paste the token and press "Get code".
3. Send `/start <code>` to the bot (the code is valid for 24 hours).

Plain text goes to Claude exactly like speech. Commands: `/projects`, `/status`, `/history`, `/stop`. Buttons appear for plans, questions and risky commands, and only work on the latest message in the current stage. Only the bound chat is obeyed; strangers get no reply. Only one running copy of the app can poll a given bot.

## How it works

- The app owns the pseudo-terminal (`node-pty`) running `claude`; Terminal.app is just a viewing window attached over a Unix socket by a tiny bridge (`resources/bridge.js`). Closing the window does not kill the session.
- The chat and Actions list come from Claude Code's structured JSONL transcript (`~/.claude/projects/...`), read incrementally by a tolerant parser, not from scraping the terminal.
- Source of truth for plan, prompt submission and end of turn is Claude Code's HTTP hooks (`PermissionRequest`, `PreToolUse`, `UserPromptSubmit`, `Stop`) served by a local server. The plan is held inside a hook until you approve.
- Speech-to-text is a Swift helper over `DictationTranscriber` (Russian is not available in `SpeechTranscriber`); audio is recorded as 16 kHz WAV in the renderer.

The Russian [README.ru.md](README.ru.md) has a long list of non-obvious TUI, hook and transcript pitfalls found by experiment. Read it before touching PTY, hooks or the transcript parser. `CLAUDE.md` describes the architecture.

```
src/main/          main process: PTY, bridge, transcript, hooks, assistant, quality, Telegram
src/preload/       contextBridge into the renderer
src/renderer/      React UI
src/shared/        types and IPC contract
native/stt-helper/ Swift speech recognition helper
resources/         bridge.js for Terminal.app
```

## Limitations

- macOS on Apple Silicon only. Windows adapters are isolated but not implemented.
- Not notarized; ad-hoc signed.
- The transcript format is internal to Claude Code and may change between CLI versions. Verified against CLI 2.1.x.
- The UI language is Russian.

## Contributing

Issues and pull requests are welcome. Before sending a change run `npm run typecheck`, `npm test` and `npm run build`. Pure logic gets a `*.test.ts` next to it.

## License

[MIT](LICENSE)
