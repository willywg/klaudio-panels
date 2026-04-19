# Sprint 01 — Results (Claude in PTY)

> **Date:** 2026-04-16
> **Branch:** `sprint-01-pty`
> **Tag on merge:** `v0.1.0-pty`
> **Verdict:** ✅ **APPROVED** — proceeding to Sprint 02.

## What was validated

`claude` runs **interactively in a PTY** (`portable-pty`) inside the Tauri window; xterm.js renders the real TUI without any parsing by the app. The user confirmed that the end-to-end flow works correctly.

## The 9 steps

- [x] `bun tauri dev` opens the window without warnings.
- [x] I pick a project with previous sessions → sidebar shows the list.
- [x] 2-col layout with empty terminal on the right.
- [x] Click **"+ New session"** → the Claude Code v2.1.112 TUI appears with a greeting.
- [x] I type a prompt and Claude responds with native formatting (colors, markdown, tool cards).
- [x] Ctrl+C interrupts the turn (xterm default).
- [x] Window resize reflows the TUI (pty_resize + FitAddon).
- [x] Click on an old session → current PTY dies, `claude --resume <id>` shows the real history.
- [x] Cmd+C / Cmd+V / Cmd+K behave as expected.

## Problems detected on the first run and resolved

| # | Symptom | Cause | Applied fix |
|---|---------|-------|---------------|
| 1 | External horizontal and vertical scrollbars over xterm | Webview layers allowed overflow beyond xterm's internal control | `overflow-hidden` + `min-w/h-0` on `<main>`, grid, aside, section and container |
| 2 | Delay without feedback between "+ New session" click and the first PTY byte | No intermediate state between the invoke and the first `pty:data` | `opening` signal, `<LoadingPanel>` with spinner + "Starting Claude Code…" |
| 3 | Claude's ASCII-art icon misaligned / ghosting between cells | `lineHeight: 1.2` + default canvas renderer miscomputed the width of box-drawing chars and emojis | `lineHeight: 1.0`, `@xterm/addon-unicode11` (`activeVersion = "11"`), `@xterm/addon-webgl` with canvas fallback |

## Metrics

- **LOC Rust** (`src-tauri/src/*.rs`): 657
- **LOC TypeScript/TSX** (`src/**/*`): 557
- **Sprint commits:** 7
- **Real time:** ~1 effective day (shorter than the 2–4 day estimate — the surviving base from Sprint 00 helped a lot)

## What survived from Sprint 00

- `src-tauri/src/binary.rs` — `claude` detection via `which` + fallbacks
- `src-tauri/src/sessions.rs` — parser for `~/.claude/projects/**/*.jsonl`
- Tauri + SolidJS + Tailwind v4 scaffold
- `ProjectPicker`, `SessionsList`, 2-column layout, localStorage

## What was added in this sprint

- `src-tauri/src/shell_env.rs` — probe/load/merge of the login shell's env (direct port from OpenCode). Critical so that `Bash`/`git`/`rg`/`node` work inside Claude on a macOS GUI app.
- `src-tauri/src/pty.rs` — `portable-pty` with `pty_open/write/resize/kill`, reading in `spawn_blocking`, emitting `pty:data:<id>` and `pty:exit:<id>` via base64.
- `src/context/terminal.tsx` — single-PTY store with pub/sub for `onData`/`onExit`.
- `src/components/terminal-view.tsx` — xterm.js with FitAddon, Unicode11Addon, WebGL, WebLinks, custom keybinds.
- Wiring in `App.tsx`: sessions `--resume <id>`, "+ New session" with no args, switching project kills the PTY.

## Decisions confirmed by validation

- **Pure PTY > stream-json parsing.** The real TUI works without friction; the user gets 100% of the CLI's features.
- **Shell env hydration is mandatory.** Without `probe_shell_env`, Claude wouldn't find `node`/`git`/etc. Worked on the first try.
- **base64 for PTY bytes ↔ frontend.** Tauri serializes the payload as a string; base64 is the robust transport.
- **WebGL renderer + Unicode 11 is non-negotiable** for Claude's TUI (ASCII-art icons, progress bars, Warp glyphs).

## Sprint 02 — Next

Immediate backlog (prioritize at kickoff):

1. **Multi-tab sessions** — several concurrent PTYs with tabs, each with its own xterm.
2. **Basic file tree** — lazy side navigation + `notify` watcher (Phase 2 of `PROJECT.md`).
3. **Persist the last active session per project** — auto-resume on reopen.
4. **SQLite for app settings** — first entries: favorite projects, last session id, window size.

Open questions for Sprint 02:
- Multi-tab as tabs (browser-style) or as a sidebar list with multiple checkmarks?
- File tree as an additional collapsible panel, or does it replace the sessions sidebar?
