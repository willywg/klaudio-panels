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

Release flow: see [`docs/release-flow.md`](docs/release-flow.md).
Every release ends with a cask bump in
[`willywg/homebrew-klaudio-panels`](https://github.com/willywg/homebrew-klaudio-panels)
or brew users freeze on the previous version. Build the DMG with
`--target universal-apple-darwin` — host-arch builds break Intel users.

## What this project is

Tauri v2 + SolidJS desktop app that **embeds the real Claude Code TUI inside a native window** via PTY. The app is a shell around `claude`, not a reimplementation of it. The sidebar has two tabs per project: **Sessions** (past `~/.claude/projects/**/*.jsonl` rendered as a list; clicking resumes via `claude --resume <id>` in the PTY) and **Files** (a lazy-loaded project tree backed by `notify` + `ignore` crates). A background JSONL watcher propagates live `/rename` updates to open tab labels and correlates brand-new (non-resumed) tabs with their `sessionId` once Claude writes the first line.

## Non-negotiable architectural decisions

Settled after the Sprint 00 pivot. Don't re-propose rejected alternatives without new evidence.

1. **Claude Code runs interactively in a PTY.** No `-p`, no `--output-format`, no flag that changes behavior to non-interactive. The user sees the real TUI (colors, slash commands, permission prompts, `-r` picker, autocomplete) rendered by xterm.js.

2. **Don't parse the PTY output.** Ever. Only render bytes into xterm.js. If a feature seems to need "what did Claude just do?", solve it by watching the **filesystem + git**, not the PTY.

   **Exception — OSC 777 CLI-agent sidechannel (Sprint 04+):** the byte stream may contain `\x1b]777;notify;warp://cli-agent;<json>\x07` frames emitted by the [`warp@claude-code-warp`](https://github.com/warpdotdev/claude-code-warp) Claude Code plugin. This is a stable, public wire contract (warp's open-source CLI-agent protocol — `app/src/terminal/cli_agent_sessions/event/v1.rs`), not semantic terminal output. The sniffer in `src-tauri/src/cli_agent.rs` may inspect those frames and emit a `claude:event` Tauri event. It is **observe-only**: bytes still flow to xterm.js unchanged (xterm.js silently drops unknown OSC numbers). Anything else in the stream — model output, ANSI styling, slash-command echo — remains off-limits.

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

13. **Project-scoped direnv, resolved fresh on every spawn.** Before a PTY is opened for `claude` (`pty_open`), `project_env.rs` shells out to `direnv export json` with the project path as cwd and merges the added/changed/removed diff on top of the hydrated login-shell env. This is how a project's `.envrc` (e.g. `export CLAUDE_CONFIG_DIR=...` to run that project under a different Claude account) takes effect without reimplementing direnv's stdlib. The `direnv export json` subprocess and the final `CommandBuilder` PTY spawn both call `env_clear()` before applying the resolved env — otherwise a variable direnv (or we) meant to unset could still leak in from Klaudio's own ambient process env. **Fails closed everywhere:** if `direnv` is on PATH but evaluation errors (blocked `.envrc`, non-zero exit, malformed JSON, timeout, empty `CLAUDE_CONFIG_DIR`), both `pty_open` and `list_sessions_for_project` return `Err` instead of silently falling back to the default `~/.claude` profile. Projects without `direnv` installed, or without a `.envrc`, are unaffected. direnv's stderr is never logged or returned — errors are generic and actionable (`direnv status` / `direnv allow`); logs carry only the project path, exit/timeout status, and a changed-variable count. `list_sessions_for_project` re-resolves the same way to read from `$CLAUDE_CONFIG_DIR/projects` instead of always `~/.claude/projects`. **Caching, and what deliberately isn't cached:** `pty_open`'s own resolution is always fresh — a spawn must never inherit a stale profile. The session-list path is not: it runs on every JSONL debounce tick, so `resolve_claude_config_dir` short-circuits to the default profile via a pure `stat` walk when no `.envrc` exists in any ancestor directory, and otherwise caches the resolved dir per project keyed on that `.envrc`'s path+mtime (`CONFIG_DIR_CACHE`, LRU cap 64). A *failed* resolution is never cached — `direnv allow` doesn't touch the `.envrc` mtime, so caching a failure would strand the user until an app restart. To keep that safe rule cheap, the login-shell probe itself is memoized once per process (`SHELL_ENV: LazyLock`) rather than the resolution result: it depends only on `$SHELL`, never on the project. Note `pty.rs` and `binary.rs` still call `load_shell_env` unmemoized, so a mid-session direnv install is visible to the spawn path before the sessions path — hoisting the memo into `shell_env.rs` is open follow-up work. **Follow-up, not yet implemented:** the global JSONL watcher (`session_watcher.rs`, decision #10) still only watches the default `~/.claude/projects` — a project pinned to a non-default `CLAUDE_CONFIG_DIR` won't receive live `session:new` / `session:meta` / `session:complete` events (tab-label correlation, live `/rename`, completion notifications) until a multi-root watcher is built; those tabs simply don't get live updates, and a manual Sessions-list refresh (the sidebar's refresh button) is the workaround. **Profile identity, and why this stays safe in the meantime:** every session/tab is namespaced by a *profile id* — `"default"` when a project has no `CLAUDE_CONFIG_DIR` (or it resolves to the ordinary `~/.claude`), else `"custom:" + base64(the resolved CLAUDE_CONFIG_DIR)` (`project_env::profile_id_for_config_dir` / `#[tauri::command] resolve_profile_id`; frontend mirror in `TerminalTab.profileId`, resolved *before* a tab is created — never assigned after the fact, which would leave a window for a live event to land before the profile was known). `pty_open` takes an `expected_profile_id` and independently re-derives the actual one from the same resolved env used to spawn the child, refusing to spawn if they diverge (e.g. the `.envrc` changed between the frontend's check and the spawn) — never logging either id. `localStorage["lastSessionId:<projectPath>:<profileId>"]` (`components/last-session.ts`) replaces the old unnamespaced key; the unnamespaced key is only ever read for the `"default"` profile, and only until its value is validated once and migrated (see `lib/auto-resume.ts`). Because the JSONL watcher above is default-root-only, `session:new` / `session:meta` (`context/session-watcher.tsx`) and `session:complete` (`context/notifications.tsx`) can only ever legitimately describe a `"default"`-profile tab — every handler that could promote a tab, relabel it, raise its attention flag, route a toast/notification to it, or write its `lastSessionId` checks `profileId === "default"` first, so a custom-profile tab can be *stale* (no live update) but never *wrong* (updated from someone else's session). The OSC 777 `claude:event` sidechannel (decision #2's exception) is not part of this — it sniffs each PTY's own byte stream per-tab, not the watched directory, so it already works for every profile and must not be gated the same way.

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
- `sessions.rs` — parse `<config-dir>/projects/**/*.jsonl` for sidebar previews (read-only); `<config-dir>` is `$CLAUDE_CONFIG_DIR` when the project's direnv sets one (see `project_env.rs`), else `~/.claude/projects`. Captures `custom_title` (from `/rename`) and `summary` (auto-generated). `read_cwd` and `scan_session_file` are `pub(crate)` so the watcher can reuse them.
- `shell_env.rs` — `probe_shell_env`, `load_shell_env`, `merge_shell_env` (ported from OpenCode).
- `project_env.rs` — resolves the per-project child-process env: hydrated shell env + `direnv export json` diff (added/changed/removed vars) for the project path. Fails closed on any direnv evaluation error. Also exposes `resolve_claude_config_dir` for `sessions.rs`, and `profile_id_for_config_dir` / `#[tauri::command] resolve_profile_id` (see decision #13) for the frontend's profile-namespaced session state.
- `pty.rs` — `portable-pty` lifecycle, `pty_open/write/resize/kill`, streaming events. The id is provided by the frontend. `pty_open` spawns Claude with the env from `project_env.rs`, taking an `expected_profile_id` it validates against that same env before spawning (decision #13).
- `fs.rs` — `list_dir` (gitignore-aware via `ignore` crate) + `watch_project` / `unwatch_project` backed by `notify-debouncer-full`. LRU cap of 3 simultaneous project watchers. Emits `fs:event:<projectPath>` per debounced batch.
- `file_read.rs` — `read_file_bytes` / `read_image` for the preview panel, plus `resolve_project_file`. The resolver exists because Claude names things relative to *its own* cwd (or with no directory at all): when the direct path misses it searches the project for a file whose relative path ends with the given one on a path-segment boundary. Direct hit first, so the common case is one `stat` and no walk; the fallback uses `ignore`'s parallel walker. **One resolver for source files and images alike** — images had a second one (`resolve_project_image`, deleted in #83) with its own ranking and caps, which is how they kept a bug source files had already had fixed. **Reads reach outside the project, writes do not** (#85): `resolve_readable` takes an absolute or `~/` path at face value, because Claude's scratchpad files and screenshots can't be named relative to the open project, while a *relative* path that climbs out is still refused. `write_file_bytes` (`file_write.rs`) stays on `resolve_rel`, so Klaudio never writes outside a project you opened; the inline editor refuses an outside file up front rather than failing at ⌘S.
- `git.rs` — working-tree status (`git_status`), per-file diffs (`git_diff_file`), and the branch's commit history (`git_history` / `git_commit_detail` / `git_diff_commit_file`, #88). The two views share their machinery on purpose: `files_from_diff` does the per-file `+`/`−` accounting for both the status walk and a commit's file list, and `DiffPayload` is identical either way — the working tree diffs HEAD's blob against the file on disk, a commit diffs its first parent's blob against its own. A merge is shown against its **first parent** (what `git show` does) and reports no line stats in the list (what `git log --stat` does — the number would describe the branch it merged, not the merge). History is the project's own repo only; unlike `git_status` it does not descend into nested repos, because a submodule's history belongs to its own project. `find_commit` accepts only a hex object id, never a revspec.
- `session_watcher.rs` — global watcher over `~/.claude/projects/`. Installed once at boot via `tauri::Builder::setup`. Seeds its "seen" set at boot so pre-existing files don't fire spurious `session:new` on first modification.
- `clipboard_history.rs` — in-memory clipboard history holding only what Klaudio itself copied. The system pasteboard exposes no attribution (`changeCount` says a write happened, never who made it), so origin filtering means owning the write: a `pbcopy` shim that `pty.rs` puts on every PTY's `PATH` tees clips to a unix socket listened on here, and ⌘C in our terminals reports through `clipboard_record`. The shim always reaches the real `/usr/bin/pbcopy` and propagates its exit status — breaking the user's `pbcopy` to feed a panel would be a bad trade. Emits `clipboard:new`. 10-entry ring, re-copies promoted rather than duplicated, nothing persisted. Because we never read the system pasteboard, a password manager's clip is uncapturable by construction rather than by filtering.

Frontend (`src/`):
- `context/terminal.tsx` — multi-tab PTY store (tabs + activeTabId); write/resize/kill bindings. Tabs track `spawnedAt` for FIFO correlation and a `profileId` (decision #13) resolved by the caller before the tab is created. `promoteTab` + `setTabLabel` allow the session watcher to attach sessionIds and refresh labels.
- `context/projects.tsx` — recent projects store (list + pinned memo; touch/unpin/remove/reorder).
- `context/sidebar.tsx` — sidebar tab (Sessions | Files) + collapse state. Global collapsed, per-project active tab. Persisted in `localStorage`.
- `context/git.tsx` — per-project git store: working-tree status (refetched on `fs-event`, debounced) plus the paged commit history. History is fetched top-down as a single page of N rather than appended per page, so a refetch after a new commit re-anchors the list without snapping a user who pressed "Load more" back to page one; it is a no-op until History has actually been opened. Commit details are cached by sha — a commit is immutable, so the cap is about memory, not freshness.
- `context/session-watcher.tsx` — listens to `session:new` / `session:meta`, applies FIFO + 30s sanity guard to promote "new" tabs (exported as `findPromotionCandidate` / `shouldApplySessionMeta`, both gated on `profileId === "default"` — decision #13), and exposes a `metaBump` signal the shell uses to refresh the sessions list on live `/rename`.
- `components/terminal-view.tsx` — xterm.js mount, fit-addon, resize observer, clipboard keybinds, `refresh()` on visibility change.
- `components/tab-strip.tsx` — browser-like tab strip above the terminal.
- `components/projects-sidebar.tsx` — OpenCode-style vertical avatar column, pointer-based drag-reorder.
- `components/titlebar.tsx` — custom 40px macOS chrome (Overlay title bar style). Reserves 72px for traffic lights; hosts the sidebar toggle.
- `components/sidebar-panel.tsx` + `components/sidebar-tabs.tsx` — 280px aside with Sessions/Files tabs. Collapses to zero (OpenCode-style). Cmd+B toggles from anywhere.
- `components/file-tree/{file-tree.tsx, tree-node.tsx, use-file-tree.ts}` — lazy-loaded project tree. Depth-first flatten for rendering, fs events patch the store (never re-fetch root). Per-project store cache preserves expanded state across tab switches.
- `components/diff-panel/{commit-list.tsx, commit-tab.tsx, diff-style-toggle.tsx}` — the History half of the git tab (#88). `CommitList` is the branch's commits with the unpushed ones marked; clicking one calls `openCommit`, which opens a `commit:<sha>` tab rather than replacing the list — reviewing usually means looking at two, and master-detail in a 640px panel makes you walk back and forth. `CommitTab` renders the message plus `DiffFileRow`s carrying `source={{kind:"commit",sha}}` and an `expandKey` prefixed with the sha (expansion is keyed globally by path, so without the prefix one file would expand in every commit tab at once). Switching to History hides the Changes list rather than unmounting it — every expanded row owns a Shiki-backed `FileDiff`.
- `components/context-menu.tsx` — minimal headless context menu. Used by the file tree for Copy path / Reveal in Finder.
- `components/home-screen.tsx` — recent-projects grid.
- `components/project-picker.tsx` + `components/sessions-list.tsx` — survived from Sprint 00/01.
- `context/clipboard-history.tsx` + `components/clipboard-history-button.tsx` + `lib/record-clip.ts` — the titlebar clipboard dropdown. `applyClip` mirrors the Rust ring's promote-on-recopy so the UI stays in step between events without a round trip. The titlebar `<header>` carries `relative z-40` so its popovers beat the diff panel's composited sticky rows — see the CHANGELOG entry; z-index alone was not enough.
- `lib/session-label.ts`, `lib/recent-projects.ts`, `lib/sidebar-prefs.ts`, `lib/file-icon.ts` — pure helpers. `lib/auto-resume.ts` — pure `resolveAutoResumeTarget` decision function for auto-resume-on-open (namespaced vs. legacy `lastSessionId`, decision #13); `components/last-session.ts` owns the actual `localStorage` reads/writes it's fed through.

Cross-context communication goes through Tauri events (`pty:data:*`, `pty:exit:*`, `fs:event:<projectPath>`, `session:new`, `session:meta`, `clipboard:new`), never direct imports between contexts.

## Language

All files committed to the repo — code, comments, docstrings, commit messages, PR titles, issue titles, PRPs, sprint docs, READMEs — are in English. The user may communicate with you in Spanish; reply in Spanish when they do. English is the repo convention, not the conversation convention.
