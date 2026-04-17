# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

**Sprint 01 in progress — PTY pivot.** Branch `sprint-01-pty`.

Sprint 00 (stream-json PoC) is tagged `v0.0.1-stream-json-poc` and archived. See `docs/sprint-00-stream-json-exploration.md` for why it was discarded. Full blueprint in `PROJECT.md`.

Build/test commands once the Sprint 01 code lands:

```bash
bun install
bun tauri dev              # dev server + Tauri window
bun run typecheck          # tsc --noEmit
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

## What this project is

Tauri v2 + SolidJS desktop app that **embeds the real Claude Code TUI inside a native window** via PTY. The app is a shell around `claude`, not a reimplementation of it. Sidebar lists projects and past sessions read from `~/.claude/projects/**/*.jsonl`; clicking a session spawns `claude --resume <id>` in the PTY.

## Non-negotiable architectural decisions

Settled after the Sprint 00 pivot. Don't re-propose rejected alternatives without new evidence.

1. **Claude Code runs interactively in a PTY.** No `-p`, no `--output-format`, no flag that changes behavior to non-interactive. The user sees the real TUI (colors, slash commands, permission prompts, `-r` picker, autocomplete) rendered by xterm.js.

2. **Don't parse the PTY output.** Ever. Only render bytes into xterm.js. If a feature seems to need "what did Claude just do?", solve it by watching the **filesystem + git**, not the PTY.

3. **Shell env hydration is mandatory.** macOS GUI apps inherit a stripped PATH. Spawning `claude` without merging the login shell's env breaks `node`/`nvm`/`git`/`rg` inside Claude's Bash tool. Copy `probe_shell_env` + `load_shell_env` + `merge_shell_env` from OpenCode's `packages/desktop/src-tauri/src/cli.rs` (lines ~220-365). Always set `TERM=xterm-256color`.

4. **`current_dir` on every spawn** must be the project path. Claude uses cwd to choose the encoded directory under `~/.claude/projects/`; getting this wrong means the new session never shows up in our sidebar.

5. **Session storage lives in `~/.claude/projects/<encoded>/<id>.jsonl`.** We read it for sidebar previews only. We never write there. Resume is delegated to `claude --resume <id>`; we don't rehydrate messages in the UI.

6. **SQLite (rusqlite) only for app settings** — window state, theme, favorite projects. Never for conversation history. `localStorage` is fine through the PoC.

7. **Filesystem + git are the source of truth for file state.** No custom index. File tree reacts to `notify`; diff badges from `git status`; diff content from `git2`. File tree/diff viewer arrive in Sprint 02–03.

8. **Diff rendering uses `@pierre/diffs`** (npm `^1.1.0-beta.18`) — Sprint 03.

9. **Single PTY per window in Sprint 01.** Switching session kills the current child and spawns a new one. Multi-tab is Sprint 02; don't pre-build state for it.

## PTY integration cheatsheet

Three modes, all interactive, all in a PTY with hydrated shell env:

| UI action                   | Command                    |
| --------------------------- | -------------------------- |
| Click "+ Nueva sesión"      | `claude`                   |
| Click "Continuar última"    | `claude -c`                |
| Click a session in sidebar  | `claude --resume <id>`     |

Rust commands to expose:

- `pty_open(project_path, args: Vec<String>) -> String` (returns pty id)
- `pty_write(id, bytes)`
- `pty_resize(id, cols, rows)`
- `pty_kill(id)`
- Events: `pty:data:<id>` (base64 or raw bytes) and `pty:exit:<id>`

## Reference repos (local clones)

| Repo | Path | Use for | Don't copy |
|---|---|---|---|
| **OpenCode Desktop** (anomalyco/opencode) | `~/proyectos/open-source/opencode` | **Primary reference now**: `packages/desktop/src-tauri/src/cli.rs` L220-L365 for shell env hydration (verbatim); `packages/app/src/components/terminal.tsx` and `context/terminal.tsx` for xterm-like integration patterns (they use ghostty-web, we use xterm.js; structure transfers); `packages/app/src/pages/session/terminal-panel.tsx` for Sprint 02 tabs. | `cli.rs` **above line 220** — that's sidecar-HTTP for their OpenCode server CLI, doesn't apply to `claude` which has no server. Anything under `packages/opencode/`, `packages/sdk/`, `packages/shared/` (their LLM server). `ghostty-web` — they fork it; we use xterm.js. |
| **Claudia** (getAsterisk/claudia) | `~/proyectos/open-source/claudia` | Sprint 00 archive only. Used for initial stream-json PoC. `src-tauri/src/claude_binary.rs` was the base for our `binary.rs` and `src-tauri/src/commands/claude.rs` lines 180-230 were the base for `extract_first_user_message` in `sessions.rs`. | Everything else — it's the approach we pivoted away from. |

## Module boundaries

Rust (`src-tauri/src/`):
- `binary.rs` — detect `claude` (which + nvm/volta/asdf fallbacks + `--version` validation). Kept from Sprint 00.
- `sessions.rs` — parse `~/.claude/projects/**/*.jsonl` for sidebar previews (read-only). Kept from Sprint 00.
- `shell_env.rs` — `probe_shell_env`, `load_shell_env`, `merge_shell_env` (port from OpenCode).
- `pty.rs` — `portable-pty` lifecycle, `pty_open/write/resize/kill`, streaming events.

Frontend (`src/`):
- `context/terminal.tsx` — single active PTY id, write/resize bindings.
- `components/terminal-view.tsx` — xterm.js mount, fit-addon, resize observer, clipboard keybinds.
- `components/project-picker.tsx` + `components/sessions-list.tsx` — survived from Sprint 00.

Cross-context communication goes through Tauri events (`pty:data:*`, `pty:exit:*`), never direct imports between contexts.

## Language

PROJECT.md and commit bodies mix Spanish (user-facing narrative) and English (code identifiers, technical decisions). Match the surrounding style. Docstrings, variable names and structured logs in English.
