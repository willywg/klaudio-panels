# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

**Pre-scaffold.** Only `PROJECT.md` (the blueprint) exists. No `package.json`, no `Cargo.toml`, no source code yet. When asked to "start Phase 1" or similar, scaffold with:

```bash
bun create tauri-app claude-desktop --template solid-ts
```

Until that happens, there are no build/lint/test commands to run.

## What this project is

Tauri v2 + SolidJS desktop wrapper around the **Claude Code CLI** (`claude`). Full blueprint in `PROJECT.md` — read it before making architectural suggestions.

## Non-negotiable architectural decisions

These were debated and settled. Don't re-propose the rejected alternatives without a new reason.

1. **Two channels to Claude Code, not one.**
   - **Primary (chat):** `claude -p --output-format stream-json --verbose` spawned as a **normal subprocess with piped stdio** (`tokio::Command` + `Stdio::piped()`). Parse stdout line-by-line as JSON. The first `system`/`init` event carries `session_id`; isolate all subsequent events per session.
   - **Secondary (free terminal):** `portable-pty` + xterm.js. Independent of the chat.
   - **Rejected:** spawning `claude` in a PTY and ANSI-parsing the TUI. Brittle across CLI updates.

2. **Don't invent session storage.** Claude Code already persists sessions at `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. Parse those files for history. Resume via `claude -p --resume <id>` or `-c`.

3. **SQLite (rusqlite, bundled) only for app settings** — window state, theme, favorite projects, binary path overrides. Not for chat history.

4. **Filesystem + git are the source of truth for file state.** No custom index. File tree reacts to `notify` events; diff badges come from `git status`; diff content comes from `git2`.

5. **Diff rendering uses `@pierre/diffs`** (npm `^1.1.0-beta.18`). Normalize git output into its format.

## Reference repos (local clones)

Two local clones exist for pattern mining. Treat them as read-only documentation.

| Repo | Path | Use for | Don't copy |
|---|---|---|---|
| **Claudia** (getAsterisk/claudia) | `~/proyectos/open-source/claudia` | Claude Code integration patterns: `claude_binary.rs` (binary detection), `commands/claude.rs` (stream-json spawn, session_id extraction, event emission), `list_projects` (JSONL parsing) | React stack, UI components |
| **OpenCode** (anomalyco/opencode) | `~/proyectos/open-source/opencode` | UI patterns: `packages/ui/src/pierre/` and `session-review.tsx` (diff viewer), `packages/app/src/components/file-tree.tsx`, `packages/app/src/context/file.tsx` (LRU cache, watcher) | `packages/desktop/src-tauri/src/cli.rs` is **not** a PTY spawner — it's a sidecar-over-pipes HTTP server pattern and does not apply here. `terminal.tsx` uses `ghostty-web` + WebSocket to a remote PTY, not local xterm.js — don't cite it as precedent. Everything under `packages/opencode/`, `packages/sdk/`, `packages/shared/` is OpenCode's own LLM server and irrelevant. |

Claudia is the primary reference for anything Claude-CLI-adjacent. OpenCode is the reference for diff/file-tree UI only.

## Module boundaries (planned, see PROJECT.md)

Rust (`src-tauri/src/`):
- `binary.rs` — detect `claude` via `which` crate + nvm/volta/asdf fallbacks
- `claude.rs` — stream-json spawn, per-session event emission, cancel/resume
- `pty.rs` — `portable-pty` for the free terminal only
- `sessions.rs` — read-only parser for `~/.claude/projects/**/*.jsonl`
- `git.rs` — `git2` diffs (working / staged / branch / turn-snapshot)
- `fs.rs` — readdir/read/write + `notify` watcher → Tauri events
- `config.rs` — SQLite for app settings

Frontend contexts (`src/context/`): `claude`, `pty`, `project`, `file-tree`, `editor`, `diff`, `git`, `config`, `session`. Each context owns one concern; cross-context calls go through signals, not direct imports.

## Language

The blueprint (`PROJECT.md`) and commit messages so far are a mix of Spanish and English. Match the surrounding style — user-facing strings and PROJECT.md content tend toward Spanish; code identifiers, commit subjects, and technical docs are English.
