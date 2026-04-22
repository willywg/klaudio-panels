# Changelog

All notable changes to Klaudio UI are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
semantic versioning from v0.2.0 onwards (pre-`v0.2.0` tags are PoC snapshots).

## [0.8.1] — 2026-04-21

### Changed
- **Uncaught error forwarding now captures the error name and message**,
  not just the raw stack. WebKit's `error.stack` is bare frames (no
  leading `TypeError: …` line), so the Rust log used to tell us *where*
  something threw without telling us *what*. Diagnostic build for a
  user-reported "blank Claude panel" issue.

## [0.8.0] — 2026-04-21

### Added
- **Drag files from the Files sidebar into the Claude terminal** to insert
  them as `@<rel>` references. Claude Code accepts the same `@path` syntax
  a user would type, so code files become attachments and images
  (`.png`/`.jpg`/...) are read as image attachments. Drop overlay appears
  when a Klaudio drag enters the terminal; native Finder drops are left
  alone for a future feature.
- **`Cmd+1` … `Cmd+9` jumps to the Nth pinned project** in the sidebar.
  Matches the convention used by browser tabs, iTerm, and Slack — `Cmd+9`
  always jumps to the last project regardless of count. Index is the
  visual order (drag-reorder still the source of truth).

### Fixed
- **Shell dock lost scrollback when switching projects.** The dock used
  `<Show>` to mount the panel only for the active project, which disposed
  the xterm instance on every project switch even though the PTY stayed
  alive. Switched to the same pattern the Claude tab strip uses — mount a
  panel for every project with live shell PTYs, stack them absolute-
  positioned, and toggle visibility. Returning to a project now shows the
  same buffer it had.
- **Pasting in any PTY view popped WebKit's "Paste" permission bubble.**
  `navigator.clipboard.readText()` triggers the native prompt in Tauri
  webviews; switched to `tauri-plugin-clipboard-manager`, which reads the
  macOS pasteboard from Rust. Pastes now use `term.paste()` so Claude /
  nvim / helix see bracketed-paste markers (`\x1b[200~ … \x1b[201~`) when
  the inner app has `?2004h` active — fixes multi-line pastes triggering
  per-line autoindent in editors.
- **Closing the app left the outer `bun tauri dev` terminal stuck in
  alt-screen with a blinking cursor.** Added a `TtyGuard` with `Drop` in
  Rust that emits the ANSI reset sequence (exit alt-screen + show cursor
  + disable bracketed paste / mouse tracking / focus reporting) as the
  process unwinds. Fires on clean exit and panic; SIGKILL still bypasses
  it, but that's rare.
- **Drag-drop from the file tree used to show the "+" cursor but never
  delivered.** Tauri v2 on macOS registers a native dragging destination
  on the `NSView` by default, which intercepts drops before the webview
  sees them. Set `dragDropEnabled: false` on the main window so
  within-webview HTML5 drag-drop works end-to-end.

## [0.7.1] — 2026-04-20

### Fixed
- **Shift+Enter submitted the Claude Code prompt instead of inserting a
  newline.** Warp and iTerm's `/terminal-setup` map `Shift+Return` to
  `ESC+CR` (`\x1b\r`); we now do the same, with an explicit
  `preventDefault()` on the KeyboardEvent so xterm's hidden textarea
  doesn't race us by inserting a plain `\n` first.
- **Claude terminal rendered narrow on the very first project / session
  load**, only recovering after the user opened the files or diff panel.
  The single `requestAnimationFrame(safeFit)` fired before the split
  container finished settling. Now staggered at `fonts.ready` / `rAF` /
  `180ms` / `500ms` — same belt-and-suspenders as the embedded editor view.

## [0.7.0] — 2026-04-16 (Sprint 07)

### Added
- **Shell terminal dock** at the bottom of the workspace, OpenCode-style:
  toggle with `Cmd+J`, multi-tab (`Terminal 1`, `Terminal 2`, …), per-
  project auto-spawn of the first tab. The dock sits below the Claude
  terminal / diff split but never under the `Sessions`/`Files` sidebar.
- **UI rebrand to Klaudio.** Window title, bundle identifier, and docs
  updated. Product name: Klaudio UI.
- **DMG hardening.** Ad-hoc codesign (`signingIdentity: "-"`) with
  embedded entitlements for hardened runtime, so the distributed DMG
  launches without per-launch Gatekeeper warnings.

### Fixed
- **`^[[I` appearing at top of fresh Claude sessions.** Claude Code
  enables `?1004h` (focus-in / focus-out reporting) very early — before
  flipping the PTY to raw mode — so the tty's ECHO echoes the focus
  pings back as literal `^[[I`. We now filter CSI-I / CSI-O from the
  outbound stream in `terminal-view`.
- **`which` picked up the stale Homebrew `claude` shim** instead of the
  native installer at `~/.local/bin/claude`. Reordered `binary.rs` to
  prefer the Anthropic native installer paths before the shell-`which`
  fallback, so users with both get the newer binary.
- **"Ghost sessions"** (JSONL files that only contain a
  `file-history-snapshot` with no user/assistant turns) are now filtered
  out of the sidebar instead of appearing as un-resumable entries.

## [0.6.0] — 2026-04-14 (Sprint 06)

### Added
- **Embedded terminal editors.** Opening a file with `nvim` / `helix` /
  `vim` / `micro` spawns the editor in a secondary PTY inside a diff-
  panel tab, so you never leave Klaudio to edit. Per-tab PTY lifecycle,
  killed cleanly when the tab closes.

## [0.5.0] — 2026-04-11 (Sprint 05)

### Added
- **Open-in editor dropdown** on files. Integrates detected GUI editors
  (VS Code / Cursor / Zed / JetBrains family) plus terminal editors and
  remembers the user's default.
- **File preview tab** in the diff panel — any file can be previewed
  syntax-highlighted (Shiki) without opening it in an external editor.
- **`Cmd+click` on file paths in the terminal** opens them in the
  preview tab.
- **Real macOS app icons** pulled via `NSWorkspace` / `NSImage` /
  `NSBitmapImageRep` for the editor dropdown.

## [0.4.0] — 2026-04-08 (Sprint 04)

### Added
- **Git diff viewer** as a right-side panel. Status badges on the file
  tree (`M` / `A` / `D` / `?`), file-level diffs rendered with
  `@pierre/diffs`, summary line showing `+N / -M` for the working tree.

## [0.3.0] — 2026-04-05 (Sprint 03)

### Added
- **Custom 40px macOS titlebar** (OpenCode-style) with `Overlay` title-
  bar style; reserves 72px for the traffic lights and hosts the sidebar
  toggle.
- **Lazy-loaded file tree** backed by `notify` + `ignore` crates, with
  gitignore awareness. Per-project LRU cap of 3 watchers.
- **Sidebar tabs**: `Sessions` / `Files`, collapse to zero width
  (`Cmd+B`). Global collapsed state, per-project active tab.
- **Global JSONL watcher** over `~/.claude/projects/` — live `/rename`
  propagates to open tab labels; new tabs (`claude` without `--resume`)
  get correlated to their real `sessionId` once the JSONL appears.

## [0.2.1] — 2026-03-28

### Changed
- **Public-ready English pass.** All code, comments, commit messages,
  docs, and PR titles translated to English (repo convention).
- Added `README.md`, `LICENSE`, `CONTRIBUTING.md`.

## [0.2.0] — 2026-03-20 (Sprint 02)

### Added
- **Multi-tab per window.** Each tab owns its own PTY child; closing a
  tab kills only that PTY. Switching tabs toggles visibility so xterm
  scrollback and WebGL state survive.
- **Last-session persist per project** (`localStorage[lastSessionId:*]`)
  with auto-resume when re-opening a project.
- **Recent projects sidebar** with Slack-style drag-reorder and
  pinned/unpinned distinction.

## [0.1.0-pty] — 2026-03-12 (Sprint 01)

### Added
- **PTY proof of concept.** Claude Code runs interactively inside
  `portable-pty`; xterm.js + FitAddon + WebglAddon in the frontend.
- Shell-env hydration (`probe_shell_env` / `load_shell_env` /
  `merge_shell_env`) ported from OpenCode, so `node`/`nvm`/`git`/`rg`
  resolve correctly when Claude spawns its Bash tool.
- JS-owned PTY ids so event subscription precedes the spawn, avoiding
  the welcome-banner race.

## [0.0.1-stream-json-poc] — 2026-03-05 (Sprint 00, archived)

Initial `claude -p --output-format stream-json` proof-of-concept.
Archived after the pivot to the PTY approach in Sprint 01.
