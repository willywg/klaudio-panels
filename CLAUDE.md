# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

**Sprint 03 in progress — file tree + JSONL watcher + sidebar tabs.** Branch `sprint-03-file-tree-and-watcher`. PRP at `PRPs/004--file-tree-and-jsonl-watcher.md`. Sprint 03a (english translation) merged to `main` and tagged `v0.2.1`.

Sprint 02 merged and tagged `v0.2.0` (multi-tab + last-session persist). Sprint 01 (PTY PoC) tagged `v0.1.0-pty`. Sprint 00 (stream-json PoC) archived with tag `v0.0.1-stream-json-poc`. Full blueprint in `PROJECT.md`; Sprint 02 plan in `docs/sprint-02-multi-tab.md` + `PRPs/003--multi-tab-and-session-persist.md`; Sprint 02 retro in `docs/sprint-02-results.md`.

Build/test commands:

```bash
bun install
bun tauri dev              # dev server + Tauri window
bun run typecheck          # tsc --noEmit
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

## What this project is

Tauri v2 + SolidJS desktop app that **embeds the real Claude Code TUI inside a native window** via PTY. The app is a shell around `claude`, not a reimplementation of it. The sidebar has two tabs per project: **Sessions** (past `~/.claude/projects/**/*.jsonl` rendered as a list; clicking resumes via `claude --resume <id>` in the PTY) and **Files** (a lazy-loaded project tree backed by `notify` + `ignore` crates). A background JSONL watcher propagates live `/rename` updates to open tab labels and correlates brand-new (non-resumed) tabs with their `sessionId` once Claude writes the first line.

## Non-negotiable architectural decisions

Settled after the Sprint 00 pivot. Don't re-propose rejected alternatives without new evidence.

1. **Claude Code runs interactively in a PTY.** No `-p`, no `--output-format`, no flag that changes behavior to non-interactive. The user sees the real TUI (colors, slash commands, permission prompts, `-r` picker, autocomplete) rendered by xterm.js.

2. **Don't parse the PTY output.** Ever. Only render bytes into xterm.js. If a feature seems to need "what did Claude just do?", solve it by watching the **filesystem + git**, not the PTY.

3. **Shell env hydration is mandatory.** macOS GUI apps inherit a stripped PATH. Spawning `claude` without merging the login shell's env breaks `node`/`nvm`/`git`/`rg` inside Claude's Bash tool. Copy `probe_shell_env` + `load_shell_env` + `merge_shell_env` from OpenCode's `packages/desktop/src-tauri/src/cli.rs` (lines ~220-365). Always set `TERM=xterm-256color`.

4. **`current_dir` on every spawn** must be the project path. Claude uses cwd to choose the encoded directory under `~/.claude/projects/`; getting this wrong means the new session never shows up in our sidebar.

5. **Session storage lives in `~/.claude/projects/<encoded>/<id>.jsonl`.** We read it for sidebar previews only. We never write there. Resume is delegated to `claude --resume <id>`; we don't rehydrate messages in the UI.

6. **SQLite (rusqlite) only for app settings** — window state, theme, favorite projects. Never for conversation history. `localStorage` is fine through the PoC.

7. **Filesystem + git are the source of truth for file state.** No custom index. File tree reacts to `notify`; diff badges from `git status`; diff content from `git2`. File tree/diff viewer arrive in Sprint 03–04.

8. **Diff rendering uses `@pierre/diffs`** (npm `^1.1.0-beta.18`) — Sprint 04.

9. **Multi-PTY per window with tabs (Sprint 02+).** Each tab is an independent child with its own `pty_open`; closing a tab kills only that PTY. Switching tabs toggles visibility (never re-creates the xterm.js instance — that would lose scrollback and break FitAddon/WebGL). The last active session per project is persisted in `localStorage["lastSessionId:<projectPath>"]` and auto-resumes when the project is reopened. "New" tabs (without `--resume`) are born with `sessionId: null` and get correlated to their real sessionId once the JSONL watcher (Sprint 03) sees a new file appear under the project's encoded dir — FIFO over `spawnedAt` with a 30s sanity guard. DO NOT persist the full list of open tabs — re-spawning N PTYs on startup = unpredictable UX.

10. **Single global JSONL watcher (Sprint 03+).** One `notify-debouncer-full` watcher over `~/.claude/projects/` is installed once at app boot. First sighting of a `.jsonl` emits `session:new`; any subsequent modification emits `session:meta`. Frontend subscribes on flat event names (`session:new`, `session:meta`), not per-project globs (Tauri v2 doesn't support glob listens cleanly). Don't spin up per-project session watchers.

11. **File-tree watcher is per-project, LRU cap 3.** Installed in `fs.rs` on demand when the user opens the Files tab for a project. Eviction drops the debouncer, which stops the worker thread. Don't raise the cap without measuring — each recursive `notify` watcher costs ~5-15MB + kqueue fds on macOS.

12. **Custom titlebar + collapsible sidebar (OpenCode-style).** The macOS titlebar uses `titleBarStyle: "Overlay"` + `hiddenTitle: true` in `tauri.conf.json`. A 40px `<Titlebar>` component draws our own chrome, reserving 72px on the left for the native traffic lights. The sidebar toggle (`PanelLeft` icon) sits right after. The sidebar itself is a single 280px aside with Sessions|Files tabs that collapses to **zero** — the panel disappears entirely; only the 56px avatar column and titlebar remain. Collapsed state is global (`localStorage["sidebarCollapsed"]`); active tab is per-project (`localStorage["sidebarTab:<projectPath>"]`). Cmd+B toggles from anywhere. File-click is select-only in v1 (no open-in-editor, no preview — diff viewer is Sprint 04). Gitignored entries and dotfiles are hidden; `.git/` is explicitly skipped in event filtering even though `ignore` handles most of it.

## PTY integration cheatsheet

Three modes, all interactive, all in a PTY with hydrated shell env:

| UI action                   | Command                    |
| --------------------------- | -------------------------- |
| Click "+ New session"       | `claude`                   |
| Click "Continue last"       | `claude -c`                |
| Click a session in sidebar  | `claude --resume <id>`     |

Rust commands to expose:

- `pty_open(id: String, project_path, args: Vec<String>) -> Result<(), String>` — id is generated by the frontend
- `pty_write(id, bytes)`
- `pty_resize(id, cols, rows)`
- `pty_kill(id)`
- Events: `pty:data:<id>` (base64-encoded bytes) and `pty:exit:<id>`

**Critical race (fixed in Sprint 02).** The JS side generates the PTY id via `crypto.randomUUID()` and subscribes to `pty:data:<id>` / `pty:exit:<id>` *before* calling `invoke("pty_open", ...)`. If Rust owned the id, the first bytes (Claude's welcome banner, ANSI init, prompt) would be emitted before the frontend attached listeners and the terminal would render blank.

## Reference repos (local clones)

| Repo | Path | Use for | Don't copy |
|---|---|---|---|
| **OpenCode Desktop** (anomalyco/opencode) | `~/proyectos/open-source/opencode` | **Primary reference now**: `packages/desktop/src-tauri/src/cli.rs` L220-L365 for shell env hydration (verbatim); `packages/app/src/components/terminal.tsx` and `context/terminal.tsx` for xterm-like integration patterns (they use ghostty-web, we use xterm.js; structure transfers); `packages/app/src/pages/session/terminal-panel.tsx` for Sprint 02 tabs. | `cli.rs` **above line 220** — that's sidecar-HTTP for their OpenCode server CLI, doesn't apply to `claude` which has no server. Anything under `packages/opencode/`, `packages/sdk/`, `packages/shared/` (their LLM server). `ghostty-web` — they fork it; we use xterm.js. |
| **Claudia** (getAsterisk/claudia) | `~/proyectos/open-source/claudia` | Sprint 00 archive only. Used for the initial stream-json PoC. `src-tauri/src/claude_binary.rs` was the base for our `binary.rs` and `src-tauri/src/commands/claude.rs` lines 180-230 were the base for `extract_first_user_message` in `sessions.rs`. | Everything else — it's the approach we pivoted away from. |

## Module boundaries

Rust (`src-tauri/src/`):
- `binary.rs` — detect `claude` (which + nvm/volta/asdf fallbacks + `--version` validation). Kept from Sprint 00.
- `sessions.rs` — parse `~/.claude/projects/**/*.jsonl` for sidebar previews (read-only). Captures `custom_title` (from `/rename`) and `summary` (auto-generated). `read_cwd` and `scan_session_file` are `pub(crate)` so the watcher can reuse them.
- `shell_env.rs` — `probe_shell_env`, `load_shell_env`, `merge_shell_env` (ported from OpenCode).
- `pty.rs` — `portable-pty` lifecycle, `pty_open/write/resize/kill`, streaming events. The id is provided by the frontend.
- `fs.rs` — `list_dir` (gitignore-aware via `ignore` crate) + `watch_project` / `unwatch_project` backed by `notify-debouncer-full`. LRU cap of 3 simultaneous project watchers. Emits `fs:event:<projectPath>` per debounced batch.
- `session_watcher.rs` — global watcher over `~/.claude/projects/`. Installed once at boot via `tauri::Builder::setup`. Seeds its "seen" set at boot so pre-existing files don't fire spurious `session:new` on first modification.

Frontend (`src/`):
- `context/terminal.tsx` — multi-tab PTY store (tabs + activeTabId); write/resize/kill bindings. Tabs track `spawnedAt` for FIFO correlation. `promoteTab` + `setTabLabel` allow the session watcher to attach sessionIds and refresh labels.
- `context/projects.tsx` — recent projects store (list + pinned memo; touch/unpin/remove/reorder).
- `context/sidebar.tsx` — sidebar tab (Sessions | Files) + collapse state. Global collapsed, per-project active tab. Persisted in `localStorage`.
- `context/session-watcher.tsx` — listens to `session:new` / `session:meta`, applies FIFO + 30s sanity guard to promote "new" tabs, and exposes a `metaBump` signal the shell uses to refresh the sessions list on live `/rename`.
- `components/terminal-view.tsx` — xterm.js mount, fit-addon, resize observer, clipboard keybinds, `refresh()` on visibility change.
- `components/tab-strip.tsx` — browser-like tab strip above the terminal.
- `components/projects-sidebar.tsx` — OpenCode-style vertical avatar column, pointer-based drag-reorder.
- `components/titlebar.tsx` — custom 40px macOS chrome (Overlay title bar style). Reserves 72px for traffic lights; hosts the sidebar toggle.
- `components/sidebar-panel.tsx` + `components/sidebar-tabs.tsx` — 280px aside with Sessions/Files tabs. Collapses to zero (OpenCode-style). Cmd+B toggles from anywhere.
- `components/file-tree/{file-tree.tsx, tree-node.tsx, use-file-tree.ts}` — lazy-loaded project tree. Depth-first flatten for rendering, fs events patch the store (never re-fetch root). Per-project store cache preserves expanded state across tab switches.
- `components/context-menu.tsx` — minimal headless context menu. Used by the file tree for Copy path / Reveal in Finder.
- `components/home-screen.tsx` — recent-projects grid.
- `components/project-picker.tsx` + `components/sessions-list.tsx` — survived from Sprint 00/01.
- `lib/session-label.ts`, `lib/recent-projects.ts`, `lib/last-session.ts`, `lib/sidebar-prefs.ts`, `lib/file-icon.ts` — pure helpers.

Cross-context communication goes through Tauri events (`pty:data:*`, `pty:exit:*`, `fs:event:<projectPath>`, `session:new`, `session:meta`), never direct imports between contexts.

## Language

All files committed to the repo — code, comments, docstrings, commit messages, PR titles, issue titles, PRPs, sprint docs, READMEs — are in English. The user may communicate with you in Spanish; reply in Spanish when they do. English is the repo convention, not the conversation convention.
