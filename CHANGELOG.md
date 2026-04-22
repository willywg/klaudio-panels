# Changelog

All notable changes to Klaudio UI are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
semantic versioning from v0.2.0 onwards (pre-`v0.2.0` tags are PoC snapshots).

## [0.9.4] — 2026-04-22

### Added
- **Cmd+← / Cmd+→ jump to start/end of the prompt line.** Matches the
  iTerm2 "Natural Text Editing" preset and Warp's default. The custom
  xterm key handler translates each to `Ctrl+A` / `Ctrl+E`, which Ink's
  text input (Claude Code prompt) and every POSIX line editor
  (bash/zsh/fish) honor as home/end. Applied to both the Claude
  terminal view and the shell dock.

## [0.9.3] — 2026-04-22

### Fixed
- **Cmd+V no longer pasted images into Claude Code.** The previous duplicate-
  paste fix added `preventDefault()` + `if (text) term.paste(text)`, so an
  image-only clipboard short-circuited the handler (empty text → skipped).
  The WebKit right-click → Paste path still worked because xterm's native
  paste listener calls `term.paste("")` unconditionally, and Claude Code
  treats an empty bracketed-paste (`ESC[200~ESC[201~`) as its cue to sniff
  the NSPasteboard for an image. Mirror that: always call `term.paste()`,
  using the clipboard text if any and `""` otherwise, so the markers reach
  the PTY and Claude Code finds the image via `osascript`/its native
  clipboard module.

## [0.9.2] — 2026-04-22

### Added
- **URLs in any terminal now open in the system default browser.** Wired
  `xterm.WebLinksAddon` with a handler that calls `@tauri-apps/plugin-opener`'s
  `openUrl`. WebKit's default `window.open(uri, "_blank")` either no-ops
  or opens a second webview inside Tauri; users expect Safari/Chrome.
  Applied consistently across the Claude terminal, shell dock, and
  embedded editor PTY views.

### Fixed
- **Cmd+V pasted text twice.** The custom key handler called
  `term.paste()` with the clipboard contents but didn't `preventDefault()`,
  so the webview's native paste also fired into xterm's hidden textarea
  and xterm forwarded those bytes through `onData` — the PTY received the
  same string twice. Matches the same `preventDefault()` the Shift+Enter
  branch already used.
- **Shell terminals cross-bled between projects on switch.** CSS quirk:
  `visibility: visible` on a child **overrides** `visibility: hidden` on
  an ancestor (the one CSS property that cascades that way). The outer
  `<App>` wrapper hides inactive projects' dock panels, but the per-tab
  `<div>` inside `ShellTerminalPanel` was forcing `visibility: visible`
  on the selected tab of every panel — re-exposing the inactive
  project's xterm canvas. Being absolute-positioned siblings, whichever
  panel came later in DOM won visually. Switched the inner toggle from
  `tabSelected()` to `visible()` (tabSelected && panel active) so the
  inner `visible` only ever appears when the outer panel is also
  visible. `z-index` tightened for the same reason.
- **Diff / file-preview panel state is now per-project.** The panel
  used a single global open/closed flag that leaked across projects —
  opening it in A also opened it in B, closing it in B re-closed it in
  A, and App.tsx compensated by force-closing on every project switch
  (so a panel you'd opened in A was gone when you came back). Migrated
  to a per-project `Record<string, boolean>` backed by
  `localStorage["diffPanelOpen:<projectPath>"]`, threaded `projectPath`
  through `isOpen` / `openPanel` / `close` / `toggle`, and removed the
  force-close effect on project switch. Each project now remembers its
  own panel state across switches and app restarts.
- **Right-click on a project avatar no longer closes the project.** The
  context-menu handler was wired to the destructive "close project"
  flow. A single accidental right-click was enough to kill all PTYs and
  unpin the project; one user also reported a rare follow-on where the
  other projects' Claude/shell panels blanked. `onContextMenu` now only
  suppresses the native menu; close is available via the hover × button
  only. Tooltip updated.

## [0.9.1] — 2026-04-22

### Fixed
- **Black Claude panel on some WebKit builds.** `@xterm/xterm@6.0.0`'s
  shipped bundle has a closure-capture bug in `requestMode` that throws
  `ReferenceError: Can't find variable: i` under WebKit's stricter
  scoping, corrupting the parser state on the very first write. Claude
  Code probes mode 2026 (synchronized output) via `CSI ? 2026 $ p` at
  startup, so the crash hit on every spawn. Short-circuited DECRQM with
  `term.parser.registerCsiHandler({ prefix: "?", intermediates: "$",
  final: "p" }, () => true)` so the built-in handler never runs; Claude
  gets no reply and falls back to "not supported", same as pre-xterm-6
  behavior. Diagnosed from Oliver's v0.8.1 diagnostic log.

## [0.9.0] — 2026-04-22

### Added
- **Language-aware file icons** in the Files tree. `file-icon.ts` grew
  from 5 generic buckets to ~70 entries, matching by full filename
  (`Dockerfile`, `Makefile`, `.gitignore`, `package.json`, `Cargo.toml`,
  `pyproject.toml`, `uv.lock`, `.env*`, ...) plus per-extension icons
  with tailwind color classes so `.ts` is blue, `.rs` orange, `.py`
  yellow, `.md` sky, etc.
- **Header action bar** above the tree: New File, New Folder, Refresh,
  show/hide Hidden (Eye / EyeOff), and Collapse All. New file / folder
  opens an inline input rendered at the target directory's depth.
- **Target-aware create.** Selecting a directory → creates inside it;
  selecting a file → creates as sibling; nothing selected → project
  root. Right-click on a directory also surfaces "New File" / "New
  Folder" that pin the target to the clicked folder regardless of
  selection. Target directory auto-expands before the input shows.
- **Delete action.** Context-menu entry with a native confirm dialog;
  also triggered by pressing Delete or Backspace while a tree row is
  focused. Uses a new `fs_delete(path, is_dir)` Rust command that
  picks `remove_file` or `remove_dir_all`.
- **Hidden / gitignored entries are visible by default.** Shown dimmed
  and italicized; the Eye / EyeOff toggle in the header hides them.
  Preference persists in `localStorage["filetree:showIgnored"]`. Only
  `.git/` itself stays hard-hidden — its contents churn on every git
  op and are pure noise in a project explorer.

### Fixed
- **Claude-written files didn't appear in the tree.** `notify`'s macOS
  FSEvents backend coalesces create + initial write into a single
  `Modify(ModifyKind::Any)` event, and the old handler only dispatched
  tree inserts on explicit `Create(File)`. Rewrote
  `event_to_payloads` to probe `path.exists()` on every event:
  exists → Created, missing → Removed, 2-path `Modify(Name)` →
  Renamed. Frontend dedupes by path so duplicate Createds are
  harmless.
- **`>` phantom on the Files tab icon.** The `FolderTree` icon's lower
  folder arm rendered as a chevron glyph at 12px; bumped to 13px with
  strokeWidth 1.75 for clearer silhouettes.

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
