# Claude Code (CLI Integration) — VS Code Extension

A clean-room VS Code extension that integrates with the [`claude` CLI](https://docs.claude.com/en/docs/claude-code/overview)
to bring a Claude Code chat experience directly into the editor. It uses the CLI's
`stream-json` protocol (`claude --print --input-format stream-json --output-format stream-json --verbose`)
to stream assistant text, tool use, and results into a webview.

> This is an independent open-source extension. It is **not** the official
> Anthropic Claude Code extension; it talks to the official `claude` CLI.

## Features

- Sidebar **and** editor-tab chat surfaces (kept in sync via a single shared session)
- Live streaming of assistant text, thinking blocks, and tool calls
- Session resume via `--resume <session-id>`
- `@-mention` insertion for selected code (`Alt+K` in the editor)
- Configurable model, permission mode, env vars, and extra CLI args
- "Open in Terminal" mode if you prefer the interactive CLI
- Esc to interrupt the current turn

## Requirements

- VS Code `>= 1.94`
- Node.js `>= 20` (build only)
- The `claude` CLI installed and on your `PATH` (or its absolute path set in
  `claudeCode.cliPath`). Install instructions: <https://docs.claude.com/en/docs/claude-code/setup>

## Build & run from source

```bash
npm install
npm run build         # writes dist/extension.js + dist/webview/*
```

Then open this folder in VS Code and press **F5** to launch an Extension
Development Host with the extension loaded.

To produce an installable `.vsix`:

```bash
npm run package       # produces claude-code-cli-0.1.0.vsix
code --install-extension claude-code-cli-0.1.0.vsix
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCode.cliPath` | `""` | Absolute path to `claude`; empty = auto-detect |
| `claudeCode.model` | `""` | Model alias passed via `--model` |
| `claudeCode.permissionMode` | `"default"` | `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| `claudeCode.useTerminal` | `false` | Open the interactive CLI in a terminal instead of the webview |
| `claudeCode.preferredLocation` | `"sidebar"` | `sidebar` or `panel` |
| `claudeCode.environmentVariables` | `[]` | Extra env vars passed to the CLI |
| `claudeCode.useCtrlEnterToSend` | `false` | Use Ctrl/Cmd+Enter to send (Enter = newline) |
| `claudeCode.additionalArgs` | `[]` | Extra args appended to every `claude` invocation |

## Commands

| Command | Default key |
|---|---|
| Claude Code: Open | — |
| Claude Code: Open in New Tab | `Ctrl+Shift+Esc` |
| Claude Code: Open in Side Bar | — |
| Claude Code: Open in Terminal | — |
| Claude Code: New Conversation | — |
| Claude Code: Resume Conversation | — |
| Claude Code: Stop / Interrupt | — |
| Claude Code: Insert @-Mention for Selection | `Alt+K` |
| Claude Code: Focus Chat Input | `Ctrl+Esc` |
| Claude Code: Show Logs | — |

## Architecture

```
┌─────────────────┐  postMessage ┌────────────────────┐  spawn  ┌──────────┐
│  Webview (UI)   │◄────────────►│  Extension Host    │────────►│ claude   │
│  main.js + CSS  │              │  ChatController    │  stdin  │ CLI      │
│                 │              │  ClaudeService     │  stdout │ stream-  │
└─────────────────┘              └────────────────────┘  JSONL  └──────────┘
```

- `src/extension.ts` — activation, command registration
- `src/chatController.ts` — bridges N webviews ↔ 1 CLI session
- `src/claudeService.ts` — child-process lifecycle, JSONL framing
- `src/chatViewProvider.ts` / `src/chatPanel.ts` — sidebar / editor surfaces
- `webview/main.js` — renders streaming events as chat bubbles
- `src/types.ts` — `StreamEvent` / message-protocol types

Each user turn re-spawns `claude` with the previous `session_id` passed via
`--resume`, which is the simplest way to chain turns when running the CLI in
non-interactive `--print` mode.

## Security

- The webview runs with a strict CSP and a per-load nonce
- The webview only loads scripts/styles from `dist/webview/`
- Untrusted workspaces are not supported (matches the official extension)

## Known limitations vs. the official extension

This is intentionally a focused MVP. It does **not** implement:

- Inline diff approval / proposed-edit flow
- Walkthrough / onboarding views
- Login/auth UI (auth is delegated to the CLI itself)
- Audio capture, plugin install UI, worktree creation
- Past-conversation browser

PRs welcome.

## License

MIT
