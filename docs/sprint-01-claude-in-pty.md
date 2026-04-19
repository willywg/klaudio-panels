# Sprint 01 — Claude Code in PTY

> **Target duration:** 2–4 effective days
> **Branch:** `sprint-01-pty`
> **Single objective:** embed `claude` running interactively inside the Tauri window, with xterm.js rendering its complete TUI. The sessions sidebar works and allows `--resume` directly in the PTY.

## Why this approach

Sprint 00 proved that stream-json works but reimplements Claude Code's UI, giving up features that already exist (slash commands, permission prompts, `-r` picker, autocomplete, hooks). Instead of wrapping it, we **embed** it: the user sees the real TUI in a native window, the way OpenCode Desktop does with its own CLI.

## Scope

### In scope
1. `portable-pty` spawns `claude` interactively with the login shell's env hydrated.
2. xterm.js renders all output as-is (colors, cursor, mouse tracking).
3. User input goes to PTY stdin via `pty_write`.
4. Window resize resizes the PTY (`pty_resize`).
5. Sessions sidebar (survives from Sprint 00):
   - Click "+ New session" → `claude` (no flags).
   - Click an existing session → `claude --resume <id>`.
   - Switching sessions kills the previous PTY.
6. Switching project kills the active PTY.
7. Shell keybinds:
   - Ctrl+C passes through to the PTY (SIGINT) — xterm.js default.
   - Cmd+C copies the selection to the clipboard (doesn't go to the PTY).
   - Cmd+V pastes from the clipboard into the PTY stdin.
   - Cmd+K clears the terminal screen.

### Out of scope (explicit)
- ❌ Multi-tab / multiple simultaneous PTYs — Sprint 02.
- ❌ File tree, diff viewer — Sprints 02-03.
- ❌ Persistence of the buffer across reload — the PTY closes with the window.
- ❌ Rehydrating history in the UI — `claude --resume` handles that itself.
- ❌ SQLite — `localStorage` is still enough.
- ❌ Custom theming — a hardcoded dark palette.

## The 9 steps (acceptance)

```
1. bun tauri dev → window opens without warnings
2. Pick a project with previous sessions (e.g. construct-ai/copilot-agent)
3. 2-col layout: sidebar with 5 sessions + panel with empty xterm.js terminal
4. Click "+ New session" → I see:
   ✻ Claude Code v2.1.112
   what do you want to do?
   > _
5. I type "list files" → Claude responds with the native TUI
   (colors, boxes, etc. exactly as in Terminal.app)
6. Ctrl+C → Claude interrupts the turn, shows a new prompt
7. I resize the window → the TUI reflows without misalignment
8. Click on an old sidebar session → current PTY dies, spawns a new one with
   --resume <id>, Claude shows the real history of that session and accepts
   continuation ("how many files were they?" replies with context)
9. Cmd+C with text selected → clipboard; Cmd+V pastes; Cmd+K clears
```

If the 9 pass, PoC approved.

## Risks and mitigations

| # | Risk | Mitigation |
|---|--------|-----------|
| 1 | macOS GUI app inherits empty PATH → `claude` can't find `node`/`git`/`rg` | `shell_env.rs` with OpenCode's `probe_shell_env` (spawn `shell -il` with `env -0`, parse null-delimited). Fallback to `-l` if `-il` times out. |
| 2 | Without `TERM=xterm-256color` Claude outputs no colors | Set it in the child env always. |
| 3 | Resize misaligns the TUI | xterm `onResize` → `invoke("pty_resize", { id, cols, rows })` with 50ms debounce. ResizeObserver on the container. |
| 4 | Cmd+C intercepts copy and sends SIGINT | xterm `attachCustomKeyEventHandler` — if Cmd is active and there's a selection, return false (don't pass it to the PTY). |
| 5 | PTY zombie when the window closes | `kill_on_drop` does not apply to `portable-pty`; register cleanup in `app.on_window_event` on `CloseRequested`. |
| 6 | PTY bytes are not valid UTF-8 | `pty:data:<id>` emits base64; frontend decodes with `atob` → `Uint8Array` → xterm `write()`. |
| 7 | `portable-pty` read in a blocking thread | Read in `tokio::task::spawn_blocking`, push into an `mpsc`; async receiver emits events. |

## Tasks (in order)

### T1 — Clean up Sprint 00 code
- [ ] Delete `src-tauri/src/claude.rs`
- [ ] Delete `src/context/claude.tsx`
- [ ] Delete `src/components/chat-view.tsx`
- [ ] Delete `src/lib/claude-events.ts` (the whole file)
- [ ] In `sessions.rs`: remove `list_session_entries` (unused)
- [ ] In `lib.rs`: drop references to the `claude` module + old commands
- [ ] `cargo check` + `bun run typecheck` clean

### T2 — Dependencies
- [ ] `cargo add portable-pty`
- [ ] `bun add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links`

### T3 — `shell_env.rs`
Direct port of OpenCode `packages/desktop/src-tauri/src/cli.rs` lines 220-365:
- `get_user_shell()` → `$SHELL` or `/bin/sh`
- `probe_shell_env(shell, mode) -> ShellEnvProbe` (spawn `shell <mode> -c "env -0"` with timeout)
- `load_shell_env(shell) -> Option<HashMap>` (try `-il`, fallback `-l`)
- `merge_shell_env(shell_env, overrides)` (overrides win)
- Skip nushell.

### T4 — `pty.rs`
State: `Mutex<HashMap<String, PtySession>>` where `PtySession` holds the master writer + child + abort handle of the read loop.

Commands:
- `pty_open(project_path, args) -> Result<String, String>` — uuid, set cwd, merge env, spawn.
- `pty_write(id, base64) -> Result<(), String>`
- `pty_resize(id, cols, rows) -> Result<(), String>`
- `pty_kill(id) -> Result<(), String>`

Read loop: `spawn_blocking` reads from the master in 4KB chunks, pushes through an `mpsc`; an async task consumes and emits `pty:data:<id>` (payload = base64 of the chunk). When the child exits, emit `pty:exit:<id>` with the code.

### T5 — Frontend: `context/terminal.tsx`
Minimal store `{ id: string | null, status: "idle" | "running" | "exited" }`. Functions `open(projectPath, args)`, `write(bytes)`, `resize(cols, rows)`, `kill()`. Listener for `pty:data:<id>` and `pty:exit:<id>`.

### T6 — Frontend: `components/terminal-view.tsx`
- Mount xterm.js on a `<div ref>`.
- Addons: `FitAddon`, `WebLinksAddon`.
- Hardcoded dark theme.
- `term.onData` → `terminal.write(bytes)` (encode as base64).
- `term.onResize` → debounced `terminal.resize(cols, rows)`.
- Window resize / `ResizeObserver` → `fitAddon.fit()` → `onResize` callback triggers `pty_resize`.
- `attachCustomKeyEventHandler` for Cmd+C/V/K.
- On unmount: `kill()` + `term.dispose()`.

### T7 — Wire up in `App.tsx`
Replace the `ChatView` mount with `TerminalView`.
On `activeSessionId` change or "+ New" click:
- `await term.kill()` (if any)
- `await term.open(projectPath, args)` with args matching the action.
`handleChangeProject` also kills the PTY.

### T8 — Manual validation
Run the 9 steps, fill in `docs/sprint-01-results.md`.

## Metrics to capture

- **Window → Claude prompt latency**: ms from "+ New" click to `> _` visible.
- **Input → echo latency**: ms from keypress to showing up in the terminal.
- **Memory**: `ps -o rss` of the Tauri process with one session running.
- **LOC** Rust + TS added in the sprint.

## Exit criteria

- [ ] 9 steps pass
- [ ] `cargo check` + `cargo clippy -- -D warnings` clean
- [ ] `bun run typecheck` clean
- [ ] `docs/sprint-01-results.md` signed off
- [ ] Merge into `main` and tag `v0.1.0-pty`

## Natural Sprint 02 (no-scope)

- Multi-tab of concurrent sessions
- Basic file tree (Phase 2 of PROJECT.md)
- Persistence of the last session id per project
