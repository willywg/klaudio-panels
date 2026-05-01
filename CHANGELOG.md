# Changelog

All notable changes to Klaudio Panels are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
semantic versioning from v0.2.0 onwards (pre-`v0.2.0` tags are PoC snapshots).

## [1.6.0] — 2026-04-30

### Added
- **Notification bell in the titlebar.** A `Bell` icon with a red
  unread counter (capped at "9+") sits in the titlebar's right
  cluster, always visible — including on the home screen. Click
  opens a 360px popover listing the recent unread events
  most-recent-first, each row showing the project name, event title,
  body, and a relative timestamp ("now", "2m ago", "1h ago"). The
  bell is the **catch-all** for "what happened while I was
  elsewhere" — every alert (toast or OS banner) populates the list,
  not just the ones that surfaced visually. Cap of 50 items in
  memory; no localStorage persistence (a Klaudio restart starts the
  bell clean by design).

  Item interactions:
  - **Click an item** → activates the originating project AND clears
    all items for that project from the bell. The amber ring on the
    avatar clears as part of the existing project-activation flow.
  - **"Mark all read"** at the bottom of the popover empties the
    list without switching project.
  - **X-dismissed toasts stay in the bell.** "X" means "hide the
    visual," not "I read this" — the user can still recover the
    body from the bell afterwards.
  - **Activating a project via the sidebar avatar** also clears its
    items, so the three indicators stay in sync.

- **Hover-pause on toasts.** Mouse-enter on a toast clears its
  auto-dismiss timer; mouse-leave schedules a fresh full-duration
  timer. The Slack/Discord pattern — simpler than tracking remaining
  time and matches the user intent of "I want to keep reading this."
  Click-to-activate and X-dismiss still short-circuit through the
  existing handlers.

## [1.5.1] — 2026-04-29

### Fixed
- **Spurious "Claude is waiting for you" toasts.** The warp plugin
  emits `idle_prompt` every 60s while Claude's prompt sits empty,
  including while the user is *reading* Claude's transcript output.
  In v1.5.0 this fired toast notifications during normal session
  reading (a 12-minute task wraps up, you start scrolling through
  the diff, 60s later a toast appears claiming Claude is waiting on
  you). Dropped server-side in `cli_agent.rs` alongside the existing
  `stop` filter — `permission_request` remains as the only OSC event
  surfaced to the frontend, and that one is the actually-blocked
  case the warp `Notification` hook is most useful for.

## [1.5.0] — 2026-04-29

### Added
- **`permission_request` and `idle_prompt` notifications via OSC 777.**
  Klaudio Panels now picks up the two Claude events the JSONL
  transcript watcher can't see — when Claude wants to run a tool that
  needs your approval, and when Claude has been waiting on you for a
  while — by adopting [warp's open-source CLI-agent
  protocol](https://github.com/warpdotdev/warp/blob/main/app/src/terminal/cli_agent_sessions/event/v1.rs)
  verbatim. Install warp's official plugin once and it works in both
  warp.app and Klaudio:

  ```bash
  claude plugin marketplace add warpdotdev/claude-code-warp
  claude plugin install warp@claude-code-warp
  ```

  An observe-only sniffer in `src-tauri/src/cli_agent.rs` peels OSC
  777 frames out of the PTY byte stream without mutating it (xterm.js
  silently drops unknown OSC numbers). A documented exception under
  CLAUDE.md non-negotiable #2 covers the carve-out — a stable, public,
  versioned wire contract isn't the same as the "don't parse the
  terminal" prohibition that rule was put in place to prevent.
  Permission requests get their own more-attention-grabbing chime
  (`pulse-c.wav` from anomalyco/opencode, MIT) and a longer banner
  hold; idle prompts reuse the existing soft chime. Closes
  [#23](https://github.com/willywg/klaudio-panels/issues/23).

- **In-app toast stack when the Klaudio window is focused.** The
  same notifications that previously routed to a macOS Notification
  Center banner regardless of focus now surface as a stack of cards
  anchored top-right under the titlebar:
  - `stop` and `idle_prompt` → neutral toast, 5s auto-dismiss.
  - `permission_request` → amber-accent toast, 10s (longer because
    Claude is actually blocked).
  - Click toast body → activates the originating project (the existing
    project-switch effect already clears the amber ring as a side
    effect). The X button dismisses without activating.
  - Stack capped at 5 visible; older toasts displaced when a 6th
    arrives.

  When the window is **blurred** the existing osascript native banner
  fires unchanged. Closes
  [#29](https://github.com/willywg/klaudio-panels/issues/29).

### Changed
- **Notification suppression simplified to a strict two-state policy.**
  Window focused → toast. Window blurred → OS banner. The v1.4.1
  `hasTabInProject` rule (which suppressed the banner when a tab was
  open even with the window blurred) is dropped; the chime + amber
  ring + Dock badge already cover the "I'm coming back, don't yell at
  me" case the suppression existed for.

## [1.4.1] — 2026-04-28

### Fixed
- **Avatar amber ring now paints for background-project completions.**
  In v1.4.0 the chime fired correctly when a Claude turn ended in any
  pinned project, but the avatar ring stayed grey for projects the
  user wasn't currently active on — exactly the case where the visual
  cue matters most. The same-project suppression introduced together
  with the OS-notification gating was being applied to the visual
  marker too, so any pinned project with an open Claude tab swallowed
  its own ring update. Split apart now: the **amber ring** suppresses
  only when the user is literally on the completing project (focused
  + active project); the **OS notification** keeps the broader "any
  tab in this project" suppression so opened-but-not-active projects
  don't push a banner; **sound** is unconditional. Closes
  [#26](https://github.com/willywg/klaudio-panels/issues/26).

### Changed
- **Dropped the 4.5s pulse-then-amber animation.** Permanent amber
  from the moment a completion lands. Feedback was that the animated
  phase was easy to miss on background projects (the focus-pause
  bought one extra cycle on alt-tab-back, but on a busy day with
  multiple projects the animation often expired before the user
  glanced over). Steady amber is the simpler "still pending" mental
  model and removes a chunk of timer + focus-watcher plumbing from
  `notifications.tsx` (~70 lines net).

## [1.4.0] — 2026-04-28

### Added
- **Task-complete notifications.** When a Claude session finishes a
  turn (`stop_reason ∈ {end_turn, max_tokens, stop_sequence, refusal}`),
  Klaudio fires three layered signals:
  - A soft chime (`pulse-a.wav` from anomalyco/opencode, MIT) through
    the renderer.
  - A native macOS notification (currently routed via
    `osascript display notification` — see [#25](https://github.com/willywg/klaudio-panels/issues/25)
    for the path back to a native UNUserNotificationCenter banner once
    upstream `mac-notification-sys` migrates off the deprecated
    NSUserNotificationCenter API).
  - A pulsing indigo ring on the project's avatar that settles to a
    steady **amber** ring after ~4.5s of *focused* time, plus a
    matching dot indicator. The pulse timer pauses while the window
    is unfocused so completions that land while you're alt-tabbed
    aren't silently missed.
  - A red badge with the count of unread projects over the Klaudio
    Panels icon in the Dock — visible from anywhere even with the app
    fully buried.
  Suppressed when the completing project already has any open Claude
  tab in your sidebar AND the window is focused (you're already
  tracking it). Sound always plays as a gentle audio cue. Detection
  is read-only against the existing global JSONL watcher; no new
  permissions, no settings file. Closes
  [#22](https://github.com/willywg/klaudio-panels/issues/22).

### Fixed
- **Closing the active Claude tab no longer leaves a black screen
  when sibling tabs from another project precede it in the global
  list.** `closeTab` now picks the next active tab from siblings
  sharing the closing tab's `projectPath` (prefer left, fall back to
  right), matching the shell-dock behavior that was already correct.
  Defense-in-depth in `App.tsx` extends the central column's empty
  state to fire when the active tab id points at a foreign-project
  tab. Closes [#20](https://github.com/willywg/klaudio-panels/issues/20).

## [1.3.0] — 2026-04-27

### Added
- **Cmd+K command palette.** Centered modal that fuzzy-searches the
  active project's sessions and files in one sectioned list (Sessions
  on top, Files below). Selecting a session activates an existing tab
  or spawns `claude --resume <id>`; selecting a file opens it in the
  diff-panel preview. A search pill in the titlebar center
  (`Search <project> ⌘K`) opens the same palette by mouse. New Rust
  command `list_files_recursive` walks the project gitignore-aware
  (mirroring `list_dir`'s filters, hard-skips `.git/`), capped at
  5000 entries with a `truncated` flag. Glob (`*`, `?`) and substring
  queries are resolved client-side as a single regex. Closes
  [#9](https://github.com/willywg/klaudio-panels/issues/9).
- **Reveal in tree on file open.** When a file lands in the diff panel
  (today via the Cmd+K palette, tomorrow from any future surface
  calling `diffPanel.openFile`), the Files sidebar switches to the
  Files tab, expands every ancestor directory of the file, scrolls
  the row into view, and flashes a brief indigo highlight that fades
  over ~1.2s. New `RevealProvider` exposes a single `pending()` signal
  carrying `{ projectPath, rel, id }`; consumers track `lastHandledId`
  to avoid self-trigger loops. The sidebar tab-switch lives in the
  always-mounted Shell so it fires even when the FileTree component
  isn't on the DOM (sidebar on Sessions). Behavior under collapsed
  sidebar (Cmd+B): no-op — explicit user choice not auto-overridden.
  Closes [#13](https://github.com/willywg/klaudio-panels/issues/13).
- **Draggable diff-panel preview tabs.** File and editor tabs can now
  be dragged onto a Claude or shell PTY to publish their `@rel`
  reference, the same way file-tree rows already worked. Closes the
  workflow loop opened by Cmd+K: ⌘K → file lands in preview → drag
  tab into Claude → continue typing. The "Git changes" pseudo-tab is
  intentionally not draggable. Refactor: extracted the ~110-line
  pointer drag block from `tree-node.tsx` into a shared
  `createInternalDrag(source)` hook in
  `src/lib/use-internal-drag.ts`; tree-node now calls into the same
  hook the new TabItem usage does. Closes
  [#12](https://github.com/willywg/klaudio-panels/issues/12).
- **Refresh button in the Git changes panel header.** A `RotateCw`
  icon next to the Unified|Split toggle re-runs `git_status` +
  `git_summary` for the active project. Mirrors the Files sidebar's
  refresh affordance — needed because external commits
  (`git commit` from another shell, `opencommit`, GUI clients) often
  only touch `.git/` internals that our fs-watcher's `is_relevant`
  filter drops on purpose to keep debouncer spam down, leaving the
  panel frozen on the pre-commit state until something else
  triggered a refetch. New `useGit().refresh(projectPath)` is a thin
  public wrapper around the previously-private `fetchNow`, idempotent
  via the existing `loading` flag. Closes
  [#16](https://github.com/willywg/klaudio-panels/issues/16).
- **Scroll-to-bottom button + ⌘↓ shortcut.** Each xterm-hosting view
  (Claude PTY, shell PTY) now renders a small floating `ChevronDown`
  button in its bottom-right corner whenever the viewport is scrolled
  up from the tail. Click → scrollToBottom; auto-hides once the
  viewport catches back up to baseY (xterm's own `onScroll` drives
  the state). ⌘↓ globally hits the same action with the same
  shell-dock disambiguation as ⌘T. Plumbing: a tiny module-level
  registry in `src/lib/terminal-scroll-bus.ts` keyed by PTY id, no
  Solid context. The button doubles as a "you have new content
  below" indicator when new PTY data lands while the user is
  scrolled up. Closes
  [#17](https://github.com/willywg/klaudio-panels/issues/17).

## [1.2.0] — 2026-04-24

### Added
- **Resizable Sessions/Files sidebar with per-project width.** A 4px
  drag handle on the sidebar's right edge resizes it live. The chosen
  width is persisted **per project** under
  `localStorage["sidebarWidth:<projectPath>"]`, mirroring the
  `sidebarTab:` and `diffPanelWidth:` patterns. Default is still 280px,
  so existing users see zero visual change until they grab the handle.
  Hard caps: min 200px, max 500px (independent of window width — keeps
  the center terminal as the priority on ultrawide monitors). Closes
  [#3](https://github.com/willywg/klaudio-panels/issues/3).

### Fixed
- **Proportional shrink of side panels on window resize.** When the
  app window narrows, the sidebar and diff panel now give back space
  proportionally instead of holding their absolute stored widths and
  crushing the center terminal. Both panels are clamped *together*
  (in a new pure helper, `src/lib/panel-layout.ts`) so the center is
  guaranteed a 360px floor whenever the diff panel is visible. The
  diff panel **auto-hides non-destructively** when the window can't
  fit sidebar + diff + a usable center — `diffPanelOpen:<path>` in
  localStorage is unchanged, so widening the window brings it back.
  Stored panel widths are never mutated by window resizes; only
  drag intent writes. Closes
  [#4](https://github.com/willywg/klaudio-panels/issues/4).
- **Terminal one row short after switching projects.** The activation
  path in `terminal-view.tsx` ran a single rAF fit, while the initial-
  mount path already used staggered fits at rAF + 180ms + 500ms with
  a comment explaining why one shot is unreliable. The two layout PRs
  above amplified the outer reflow on project switch (per-project
  sidebar width, panel auto-hide), tipping that race over often
  enough to be visible: xterm measured one row short, the shell
  prompt sat clipped below the canvas, and only a keystroke (auto-
  scroll) brought it back. The activation effect now mirrors
  onMount's staggered pattern — fit at rAF + 180ms + 500ms, with
  focus claimed only on the first pass. Closes
  [#7](https://github.com/willywg/klaudio-panels/issues/7).

### Changed
- **First test suite in the repo.** `bun test` is wired as a script
  and `@types/bun` lands as a devDep. The 10-case suite around
  `computePanelLayout` locks in the center-floor invariant across a
  rowWidth sweep — caught a 3px violation at the auto-hide threshold
  during review.

## [1.1.2] — 2026-04-23

### Changed
- **Bundle identifier changed** from `la.constructai.klaudio-panels` to
  `com.willywg.klaudio-panels`. The previous identifier used a domain
  that belongs to the maintainer's employer; the new one uses a domain
  the maintainer owns personally (`willywg.com`), which is the right
  call before the repo goes public. **Migration impact**: existing
  installs will effectively be "a new app" from macOS's perspective —
  window state, theme, and any other preference keyed by bundle ID
  will reset to defaults. Conversation history is unaffected (it lives
  in `~/.claude/projects/`, not in app preferences). Logs path is
  unchanged (`~/Library/Logs/Klaudio Panels/klaudio.log`).
- **CONTRIBUTING.md**: added a "Using AI tools" section welcoming
  contributions authored with Claude Code or similar agents, and
  pointing at the `prp-manager` skill for drafting PRPs.

### Docs
- Redacted references to a specific internal project path in four
  Sprint 00/01 planning docs; replaced with a generic placeholder.
  Purely cosmetic cleanup before publishing.

## [1.1.1] — 2026-04-23

### Added
- **`SECURITY.md`.** Vulnerability reporting policy (contact, scope,
  likely attack surfaces, what we won't treat as a security bug).
- **GitHub issue + PR templates.** `.github/ISSUE_TEMPLATE/bug_report.md`,
  `.github/ISSUE_TEMPLATE/feature_request.md`, and
  `.github/PULL_REQUEST_TEMPLATE.md`.

### Changed
- **Install dialog copy** after "Install 'klaudio' Command in PATH"
  now explains how to pick up the binary in an already-open shell
  (`rehash` / `hash -r`) and calls out the iTerm "Login shell" PATH
  gotcha when the symlink lands in `/usr/local/bin`.

## [1.1.0] — 2026-04-23

### Added
- **`klaudio` shell command.** Opens projects (or files) in the app from
  any terminal: `klaudio /path/to/project`, `klaudio .`, or
  `klaudio /path/to/file.ts` — the last variant opens the parent dir
  as the project and routes the file into the diff panel. Always opens
  a fresh Claude tab; auto-resume is suppressed for the target
  project on that invocation (the user asked for a new tab by running
  the command, so we honor that). If the app is already running, it
  activates the existing window instead of spawning a second instance.
- **"Install / Uninstall 'klaudio' Command in PATH" menu items.** Under
  a new "Klaudio" submenu in the macOS menu bar. Install symlinks the
  script shipped at `<AppBundle>/Contents/Resources/scripts/klaudio`
  into `/usr/local/bin/klaudio` (falling back to `~/.local/bin/klaudio`
  when `/usr/local/bin` isn't writable — in that case the dialog
  reminds the user to add the location to their `PATH`). Uninstall
  removes the symlink from every known location. Linux mirrors the
  flow with `~/.local/bin` only; Windows is stubbed and returns an
  error until we add a proper shim.

### How it works
- The `klaudio` shell script resolves its argument to an absolute path
  (the `.app`'s CWD at launch is `/`, so relative paths must be
  resolved before we hand them off) and invokes
  `open klaudio://open?path=<url-encoded>` on macOS / `xdg-open` on
  Linux. LaunchServices delivers the URL to the running instance via
  Apple Event "GetURL" on warm start and as a launch argument on cold
  start; both surface identically through `RunEvent::Opened { urls }`,
  which `tauri-plugin-deep-link` exposes as
  `DeepLinkExt::on_open_url`. We chose a URL scheme over
  `open -a ... --args` + `tauri-plugin-single-instance` because
  `open --args` does **not** deliver args to an already-running app —
  LaunchServices only sends an "activate" Apple event, so no second
  process spawns and the plugin callback never fires. URL schemes
  route through LaunchServices on both paths and avoid the whole
  problem.
- `cli_args::handle_url` parses the URL, classifies the path as
  directory vs file (using `std::fs::metadata`), and emits `cli:open`
  with `{ project_path, file_path? }`. The frontend listener in
  `Shell()` activates the project, marks it as already-auto-resumed
  (so the fresh tab isn't racing with a resume of the last session),
  opens a new Claude PTY tab, and if `file_path` is present opens the
  diff panel on the file's relative path.
- The menu items just emit `menu:install-cli` / `menu:uninstall-cli`
  intents; the frontend invokes the Tauri command and shows a native
  dialog with the outcome. Keeps all dialog plumbing on the JS side.

### Deps
- `tauri-plugin-deep-link` 2.4 (Rust) + `@tauri-apps/plugin-deep-link`
  2.4 (JS).
- `url` 2.5 (Rust) for `klaudio://` URL parsing.

## [1.0.0] — 2026-04-23

First release under the new name. No functional changes — purely a rename
and marker for the first public/OSS-ready cut.

### Changed
- **Product renamed from "Klaudio UI" to "Klaudio Panels."** The app
  started as a single-terminal shell; it now hosts three peer panels
  (Claude terminal, shell dock, git/diff), and the new name reflects
  that plural nature.
- **Bundle identifier changed** from `la.constructai.klaudio-ui` to
  `la.constructai.klaudio-panels`. Existing installs keep their old
  `~/Library/Application Support/la.constructai.klaudio-ui` and
  `~/Library/Logs/Klaudio UI` directories untouched; the new version
  writes to `la.constructai.klaudio-panels` and `~/Library/Logs/Klaudio Panels`
  instead. In-app settings / localStorage from v0.9.x don't carry over.
- **Rust crate** `cc-ui` → `klaudio-panels`; the Mach-O binary inside
  the `.app` is now named `klaudio-panels` (was `cc-ui`).
- **npm package** `klaudio-ui` → `klaudio-panels`.
- **Window title, Dock icon, log paths, docs, PRPs, CHANGELOG header,
  in-app home screen** all updated to the new name.
- **New icon.** Replaced the placeholder with a rooster-in-panels mark
  referencing both "Claude" and the Spanish "gallo Claudio" joke, plus
  the three-panel layout of the app. Master PNG kept at
  `src-tauri/icons/klaudio-panels-source.png`; `tauri icon` regenerates
  all platform assets from it.

## [0.9.9] — 2026-04-23

### Fixed
- **macOS release bundle shipped as Intel-only.** `bun tauri build` on
  an x86_64 Rust toolchain (very easy to end up on, e.g. a Terminal
  opened with "Open using Rosetta") emits a host-arch binary, so the
  DMGs we were distributing were x86_64 even though all our users are
  on Apple Silicon. macOS then ran Klaudio under Rosetta and warned
  "End of support for Intel-based apps" on a future macOS release.
  Switched the release path to `tauri build --target universal-apple-darwin`
  via a new `bun run release:mac` script; the resulting `.app` is a
  universal binary (`arm64` + `x86_64`) and runs natively on both
  architectures. README updated to document the new flow and warn
  against using `bun tauri build` for distribution.
- **Users on non-US keyboards couldn't type `@`, `#`, `|`, backticks
  or other Option-composed symbols.** xterm.js was configured with
  `macOptionIsMeta: true` in all three terminal views (Claude PTY,
  shell dock, diff-panel editor PTY), which intercepts the Option
  modifier before macOS composes the character — so on Spanish /
  German / French / etc. layouts, `Option+2` sent `ESC 2` to the PTY
  instead of producing `@`. Removed the override in all three places
  so xterm.js falls back to its default (`false`), matching the
  behavior of Terminal.app, iTerm2, Warp and WezTerm. Cmd+←/→ (home/end)
  still covers the common word-nav use case for anyone who relied on
  Option for emacs-style bindings.

## [0.9.8] — 2026-04-22

### Fixed
- **Git panel / file tree never reacted to filesystem changes made from
  the shell.** The Rust watcher emitted `fs:event:<projectPath>` and
  the frontend listened on the same name, but Tauri v2's event-name
  validator silently drops strings that contain filesystem separators
  — so `listen()` in git.tsx and file-tree.tsx resolved to a no-op
  subscription and no `touch`, `echo >>`, `git commit` from inside the
  shell dock ever reached the UI. Now the watcher emits a single
  `fs-event` and the envelope carries `project_path`; listeners filter
  by it. Initial fetch in `ensureFor` still ran, which is why the
  panel was up-to-date at boot but frozen afterwards.
- **`.git/` events were hard-dropped, so committing from the terminal
  left the diff panel stuck.** The watcher filter excluded everything
  under `.git/`. Now it keeps the files that signal user intent
  (`HEAD`, `index`, `packed-refs`, `refs/**`, `FETCH_HEAD`,
  `ORIG_HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `config`) and drops
  only the noisy subtrees (`objects/`, `logs/`, `hooks/`, `info/`,
  `modules/`, `lfs/`). Commits, stages, branch switches and fetches
  now refresh the status panel automatically.
- **Pasting in the shell dock duplicated the text** — same bug the
  Claude view had in v0.9.3. The shell-terminal-view Cmd+V handler
  was missing `preventDefault()`, so WebKit's native paste fired
  into xterm's textarea and the shell received the clipboard string
  twice. Mirrored the Claude view's handler (preventDefault +
  term.paste(text ?? "")).

## [0.9.7] — 2026-04-22

### Fixed
- **Terminals were blank (and the shell had lost its scrollback) after
  returning from the HomeScreen.** The project view sat inside
  `<Show when={activeProjectPath()}>`, so every home round-trip
  disposed every TerminalView / ShellTerminalView and mounted fresh
  xterms with empty buffers. A SIGWINCH trick could coax Claude (Ink
  redraws the whole TUI on resize) but not bash — bash's scrollback
  lives in xterm, not in bash, so anything the xterm forgot is gone
  for good. Fix: the project view is now always mounted, toggled with
  `visibility: hidden` + `pointer-events: none` while on Home, and
  HomeScreen is rendered as an absolute-positioned overlay on top.
  Every xterm (Claude and shell) keeps its buffer intact across home
  round-trips — same trick we already use for project switches.
  Shell scrollback now survives going home and back. Also adds a
  matching `resize` window listener to shell-terminal-view and a
  trailing `term.refresh()` to the Claude view's follow-up fit so
  genuine window resizes repaint reliably even when cols/rows don't
  change.

## [0.9.6] — 2026-04-22

### Added
- **Drag files from Finder into a terminal.** Dropping onto the
  Claude view or the shell dock pastes the file path into the prompt:
  `@relative-path` for files inside the active project, or the absolute
  path (with spaces backslash-escaped) for anything else. Multi-file
  drops are space-joined. Hit-testing uses `elementFromPoint` on
  `data-pty-kind` / `data-pty-id` markers now present on every
  xterm host. Requires re-enabling `dragDropEnabled: true`; the
  internal file-tree drag was migrated to pointer events as a result.

### Changed
- **File-tree → terminal drag is pointer-based now.** With the NSView
  drag hook turned back on, macOS intercepts every HTML5 drag before
  the webview sees it (our own tree-node drags included — that's why
  v0.7.2 had disabled `dragDropEnabled` in the first place). The tree
  node now implements its own drag via `setPointerCapture`, a floating
  indigo ghost pill for feedback, and the same
  `elementFromPoint` + `data-pty-id` hit test the Finder drop uses.
  A `window`-level `CustomEvent` carries the resolved pty target back
  to `App.tsx`, which shares the `buildDropPayload` helper with the
  Finder path so both flows produce the same `@rel` / absolute string.

## [0.9.5] — 2026-04-22

### Added
- **Cmd+T opens a new tab contextual to the focused panel.** If the user
  is typing inside the bottom shell dock, the shortcut appends a new
  shell terminal; otherwise it opens a fresh Claude Code session in the
  project's tab strip. Focus detection uses
  `document.activeElement.closest("[data-shell-dock]")`, with the shell
  panel's root div now marked by that attribute.

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
  updated. Product name: Klaudio UI (later renamed to Klaudio Panels in v1.0.0).
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
