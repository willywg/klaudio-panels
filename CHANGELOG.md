# Changelog

All notable changes to Klaudio Panels are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
semantic versioning from v0.2.0 onwards (pre-`v0.2.0` tags are PoC snapshots).

## [1.10.1] — 2026-08-20

### Added
- **Past commits in the Git panel** ([#88](https://github.com/willywg/klaudio-panels/issues/88)).
  The panel only ever knew about the working tree, so the moment Claude
  committed, the tree went clean and the review you were in the middle of
  disappeared. That is not an edge case here — Claude commits and opens the PR
  on its own, so by the time you want to look, the changes are already
  committed.

  The git tab now has a **Changes | History** toggle, the way GitHub Desktop
  splits its two tabs. History lists the branch's commits — short sha, subject,
  author, relative time, `+/−` — and **marks the ones that are not pushed yet**,
  which is the exact state you are left in after Claude commits. Clicking a
  commit opens it in its own tab with its message and its files, expandable
  into the same diffs as the working-tree view.

  Commits, not PRs, and deliberately no `gh`: a merged PR is a range of commits
  the repo already has, and reaching for GitHub would add an external binary
  that may not be authenticated, a network round-trip, and a dependency on the
  remote being GitHub — for data git holds locally.

  It cost little because nothing needed reinventing. `DiffPayload` is unchanged:
  the working-tree view diffs HEAD's blob against the file on disk, a commit
  diffs its first parent's blob against its own, and the same row component and
  the same `@pierre/diffs` instance render both. The per-file `+/−` accounting
  was pulled out of the status walk into one `files_from_diff` rather than
  copied — a second copy is how the two views would drift into disagreeing
  about the same file.

  A long commit message — a squash merge's, typically — scrolls inside its own
  region rather than pushing the file list off the bottom, and the divider
  between the two is draggable: how much of the message you want to read at a
  glance is a preference, and it is remembered.

  Details worth knowing: a merge is shown against its **first parent**, as
  `git show` does, and its list row says `merge` instead of a line count
  (`git log --stat` omits merge stats for the same reason — the number would
  describe the branch, not the merge). History covers the project's own repo
  only; a submodule's history belongs to its own project. And an fs event
  refreshes the list, so a commit made in the terminal shows up without
  touching the refresh button.
- **Clipboard history in the titlebar** ([#79](https://github.com/willywg/klaudio-panels/issues/79),
  PRP 022). Working several projects at once makes the clipboard lossy: Claude
  runs `pbcopy` to hand something over, and before it reaches an email or
  WhatsApp something else overwrites it. A new dropdown next to the
  notification bell keeps the last 10 things **Klaudio** copied; click one to
  put it back.

  Only Klaudio's own copies are recorded, and that constraint is what shapes
  the design. The system pasteboard exposes no attribution — `changeCount`
  tells you a write happened, never who made it — so filtering by origin is
  not a predicate you can add to a watcher; it requires owning the write. Two
  paths do: `spawn_pty` prepends a Klaudio-owned `pbcopy` shim to every PTY's
  `PATH` (after direnv, so an `.envrc` cannot displace it) which tees the clip
  to the real `/usr/bin/pbcopy` and to a unix socket the app listens on; and
  ⌘C in a Klaudio terminal, which was already our own code.

  The shim is built to never be worse than the real `pbcopy`: arguments are
  forwarded verbatim, the real exit status is what the caller sees, and a
  missing socket, dead socket or missing `nc` all fall through to a plain
  `exec`. The payload never touches disk.

  A side effect worth naming: because nothing observes the system pasteboard,
  a password copied from 1Password is not something this can capture even by
  accident. An earlier iteration polled `NSPasteboard.changeCount` and needed
  careful `org.nspasteboard.ConcealedType` handling to avoid exactly that; the
  safest handling of a secret turned out to be being structurally unable to
  see it.

  Nothing is persisted — the ring dies with the process. Recording can be
  turned off from the dropdown, and turning it back on does not backfill.

  The obvious version of this request — a copy button on Claude's rendered
  markdown code blocks — was rejected: it needs the PTY output parsed to find
  where a block starts and ends, which architectural decision #2 forbids, and
  it would break on a theme change or a wrapped line. The existing precedents
  do not cover it either; the file-path link providers are lexical and the OSC
  777 sidechannel is a published wire contract.

  Text only for now. Images and file URLs force a memory budget and eviction
  policy that text does not.
- **The preview opens files that live outside the project**
  ([#85](https://github.com/willywg/klaudio-panels/issues/85)). ⌘-clicking an
  absolute path printed in the terminal dead-ended on *"Couldn't read file:
  path escapes project root"* — most visibly for the markdown files Claude
  writes into its own scratchpad under `/private/tmp/claude-…` and then hands
  you by path.

  The root check was right for a *relative* path that climbs out
  (`../../.ssh/id_rsa` is a path someone got wrong, or is probing with) and
  wrong for an absolute one the user clicked. Images have read from anywhere
  since [#73](https://github.com/willywg/klaudio-panels/issues/73) for exactly
  this reason, and "Open in nvim" always did, being a PTY running the user's
  editor — our own reader was the last thing enforcing a root it had no way to
  justify. Refusing to *display* a file the user can already `cat` in the
  terminal below is the app declining to show what was just asked for.

  **Writes deliberately did not move.** `write_file_bytes` still resolves
  against the project root, so Klaudio never writes outside a project you
  opened — a property worth being able to state plainly, and one that costs
  nothing here, since an outside file still opens in your own editor through
  "Open in…". To keep that from becoming a trap that only fails at ⌘S, the
  inline editor refuses an outside file up front: ⌘E says why, and the
  context-menu entry reads "Edit (outside the project)", disabled.

  Tab labels are basenames, and a basename can now belong to a file anywhere
  on disk, so the full path moved into the tab's tooltip.

- **Terminal links survive a line wrap**
  ([#87](https://github.com/willywg/klaudio-panels/issues/87)). Found while
  QA'ing the above: it worked once the window was wide enough, which is what
  pointed at the cause. xterm stores a too-long line as N rows of exactly
  `cols` cells, and both link providers read one row at a time — so a wrapped
  path was two fragments and neither one worked. The head opened a preview
  that couldn't read it; the tail (`…/test-note.md`) matched as a *bare*
  relative name and got hunted for inside the project. Both tabs were visible
  in the same screenshot, one erroring.

  Pre-existing, but #85 turned it from occasional into constant: absolute
  paths are long, and Claude prints them all the time.

  Providers now read the whole **logical** line — walk back to the row that
  started the wrap, join the continuations, and give each match an
  `ILinkRange` whose ends may sit on different rows, which xterm underlines
  across the wrap. Matches are filtered to the row being asked about, or one
  link would register once per row it crosses.

  The offset→cell mapping is what the range math rests on, so rows are joined
  untrimmed and every cell contributes exactly one character: an emoji is two
  code units in one cell, and the second cell of a double-width character is
  empty. Both would otherwise slide later offsets onto the wrong cell — and,
  once rows are joined, onto the wrong row. `makeBareUrlLinkProvider` had the
  identical flaw and gets the same fix.

### Fixed
- **Titlebar dropdowns no longer render underneath the Git panel.** The
  clipboard, notification and "open in" popovers were painted over by the diff
  panel's sticky repo headers. Those are `z-10` against the dropdowns' `z-50`,
  so z-index alone said the dropdowns should win — but the sticky row carried
  `backdrop-blur-sm`, and in WebKit a `backdrop-filter` element is promoted to
  its own compositing layer where it can paint over a higher-z-index element in
  a different subtree. The titlebar now establishes its own stacking context
  (`relative z-40`), which fixes all three dropdowns at once, and the blur —
  which contributed almost nothing behind a 95%-opaque background — is gone.
- **Terminal file links work when the session runs in a sub-project**
  ([#81](https://github.com/willywg/klaudio-panels/issues/81)). Claude prints
  paths relative to *its own* working directory, so a session running in
  `construct-ai/ai-service` printing `tests/test_llm_client_timeout.py` sent
  the preview looking for `construct-ai/tests/…`, which does not exist —
  the path was right, it was just missing a prefix.

  When the direct path misses, `resolve_project_file` now looks for a file
  whose project-relative path ends with the given one on a **path-segment
  boundary** — so `tests/foo.py` matches `ai-service/tests/foo.py` but never
  `pkg/mytests/foo.py`, which a plain suffix check would wrongly accept.
  Candidates come back shallowest-first and the best one opens.

  When several files match — `app/main.py` exists under `core/`, `telegram/`
  and `whatsapp/` in a submodule-based project — it asks instead of guessing.
  Nothing in the printed path says which was meant, and opening the wrong
  service's file with no error shown is worse than one extra click: you read
  it, reason about it, and never find out. A single match opens straight away,
  which is the reported case.

  The search only runs after a direct hit fails, so the common case costs a
  single `stat` and no walk: measured on a real monorepo, 18µs for the direct
  hit against 39ms for the fallback. The fallback uses the `ignore` crate's
  parallel walker, which skips gitignored trees and `.git` for free — the
  single-threaded version took 230ms, enough to feel on a click. Results are
  memoised per project and path so a repeated click never re-walks.

  Shelling out to `find` or `ag` was considered and rejected: a process spawn
  is slower than an in-process walk, less portable, and would throw away the
  gitignore filtering we already get.

- **Image links work in a sub-project too**
  ([#83](https://github.com/willywg/klaudio-panels/issues/83)). The fix above
  did not reach images: `resolveImagePath` still joined any path *containing a
  slash* onto the project root unchecked — the very assumption that fix
  existed to undo. A session running in `web/` printing `public/logo.png` sent
  us to `<root>/public/logo.png`, which does not exist, and the link went
  quietly inert: no thumbnail on hover, nothing on ⌘-click.

  Only the bare-name shape (`logo.png`) was ever searched for, through a
  *second* resolver — `resolve_project_image` — with its own ranking, its own
  caps and its own frontend cache. Two resolvers answering the same question is
  why images kept a bug source files had already had fixed, so that one is now
  deleted: a bare name is a suffix with one segment, and `resolve_project_file`
  already handles suffixes. One ranking, one cache, nothing left to drift.

  What still bypasses the resolver: absolute and `~/` paths, since `read_image`
  is deliberately not project-scoped (that is how screenshots outside the
  project work at all, [#73](https://github.com/willywg/klaudio-panels/issues/73)),
  and `../` traversals, which leave the project and so are joined and handed
  to `read_image` as before.

  Ambiguity is handled differently per gesture. A ⌘-click opens the same
  picker source files get. A hover does not: it takes the best candidate and
  lives with a guess for the length of a thumbnail, because popping a modal at
  the mouse pointer for something nobody committed to opening is worse than
  being occasionally wrong about which `logo.png` gets previewed.

### Tracked work
- PRP: [`PRPs/022--clipboard-history.md`](PRPs/022--clipboard-history.md) (clipboard history)
- Issues: [#79](https://github.com/willywg/klaudio-panels/issues/79),
  [#81](https://github.com/willywg/klaudio-panels/issues/81),
  [#83](https://github.com/willywg/klaudio-panels/issues/83),
  [#85](https://github.com/willywg/klaudio-panels/issues/85),
  [#87](https://github.com/willywg/klaudio-panels/issues/87),
  [#88](https://github.com/willywg/klaudio-panels/issues/88)
- PRs: [#80](https://github.com/willywg/klaudio-panels/pull/80),
  [#82](https://github.com/willywg/klaudio-panels/pull/82),
  [#84](https://github.com/willywg/klaudio-panels/pull/84),
  [#86](https://github.com/willywg/klaudio-panels/pull/86),
  [#89](https://github.com/willywg/klaudio-panels/pull/89)

## [1.10.0] — 2026-08-07

### Added
- **A project can now run under its own Claude account, via direnv**
  ([#64](https://github.com/willywg/klaudio-panels/pull/64)). If a project's
  `.envrc` exports a `CLAUDE_CONFIG_DIR`, Klaudio spawns that project's
  sessions against it and lists sessions from it — client work under one
  account, personal projects under another, without logging in and out.
  `project_env.rs` shells out to `direnv export json` with the project as cwd
  and merges the resulting diff onto the hydrated login-shell env, so a real
  `.envrc` works as written; we don't reimplement direnv's stdlib. Both the
  direnv subprocess and the PTY spawn `env_clear()` first, so a variable
  direnv meant to unset can't leak in from Klaudio's own process env.

  It **fails closed**: a blocked, malformed, timed-out, or non-zero-exit
  `.envrc` returns an error instead of quietly falling back to `~/.claude`,
  because that fallback would show one account's sessions under another's
  project. direnv's stderr is never surfaced — the error points at
  `direnv status` / `direnv allow` instead. Projects with no `.envrc`, or
  users without direnv, are unaffected and pay nothing: that path is a
  `stat` walk up the ancestor chain, no shell and no direnv spawned.

  Every tab and stored session is namespaced by a **profile id**, resolved
  before the tab exists rather than attached afterwards. `pty_open` re-derives
  that id from the env it actually spawned with and refuses to spawn on a
  mismatch, so an `.envrc` edited between the UI's check and the spawn can't
  land a session in the wrong account.

  **Known gap:** the global JSONL watcher still only watches the default
  `~/.claude/projects`, so a custom-profile tab doesn't get live label
  updates, `/rename` propagation, or completion notifications — use the
  Sessions-list refresh button. This is stale, never wrong: every live-event
  handler checks the profile id first, so a custom-profile tab is never
  updated from a different account's session. A multi-root watcher is
  follow-up work.

### Tracked work
- PR: [#64](https://github.com/willywg/klaudio-panels/pull/64) — by
  [@reissaavedra](https://github.com/reissaavedra), the project's first
  external *feature* contribution, over three review rounds.

## [1.9.2] — 2026-08-06

### Added
- **Images are visible now, in the preview and from the terminal**
  ([#73](https://github.com/willywg/klaudio-panels/issues/73), PRP 021).
  Opening a `.png` used to render `Binary file — not shown.`; it now shows
  the image, with dimensions, size and a checkerboard behind transparency.
  And because Claude Code is a TUI, it can only print image references as
  text (`[image] ~/proyectos/…/qa2278-01.jpeg`) — hovering one of those paths
  now floats a thumbnail over the grid, and ⌘-clicking it opens the same
  preview tab the file tree uses — one view per image, wherever you came
  from, with the full-screen lightbox one button away. Bare filenames are
  resolved by searching the project (Claude lists `logo.png` far more often
  than `public/images/logo.png`, and the latter is where it actually lives).
  True inline thumbnails aren't possible: xterm renders a
  fixed-height character grid and nothing in its API can make a row taller,
  so an image occupying rows would paint over the output below it. A new
  `read_image` command is allowed outside the project root — narrowed to
  allowlisted extensions whose magic bytes agree with the name, size-capped,
  read-only — because those screenshots routinely live under a different
  project. `read_file_bytes` keeps its project-root restriction for
  everything else.

### Changed
- **Side panels resize freely now**
  ([#75](https://github.com/willywg/klaudio-panels/issues/75)). The diff/preview
  panel and the sidebar stopped growing partway across the window — a quarter
  of it on a wide display — and kept ignoring the mouse after that. Two
  ceilings existed in two places and disagreed: `computePanelLayout` clamped
  to hard `SIDEBAR_MAX = 500` / `DIFF_MAX = 800` pixels at projection time,
  which the drag handle couldn't see, so a drag past the cap updated and
  persisted a width the render then threw away. Both constants are gone. The
  only limits left are geometric — each panel's own minimum and `CENTER_MIN`
  for the terminal column — and the drag clamp and the layout projection now
  derive their maximum from the same arithmetic. Content re-wraps on resize
  as before: the preview is CSS-driven, the diff renderer carries its own
  `ResizeObserver`, and the terminal refits from its own.
- **The Git panel now shows what actually changed inside submodules**
  ([#71](https://github.com/willywg/klaudio-panels/issues/71)). A project whose
  children are separate repos rendered as `M backend +1 −1` — the gitlink
  delta, i.e. the superproject's one-line view of which commit the pointer
  names — so however many files really changed inside the child were
  invisible. The scan now descends into each nested repo (submodule or
  checked-in clone, three levels deep) and splices its own status in under a
  `backend/…` prefix, and the panel groups those rows by child project with a
  header carrying the repo name, its branch (`detached @ <sha>` when
  detached, which submodules usually are) and its own counts. The pointer row
  survives only when the child's worktree is clean, since then the moved
  pointer *is* the change. `git_diff_file` resolves the owning repo instead of
  the project, so a submodule file diffs against the child's object database
  rather than rendering as freshly added. Single-repo projects look exactly as
  before — group headers appear only when there's more than one repo.
- **A submodule whose pointer moved renders the move, not a broken diff.**
  That row is a gitlink, so its path is a *directory* — expanding it went
  looking for a blob that never existed and landed on "File not found on disk
  or in HEAD". It now shows `abc1234 → def5678` plus the new commit's subject
  line, in place of the `+1 −1` that only ever counted the pointer file.
- **New files now show their contents in the diff panel.** Expanding an added
  or untracked file rendered an empty box, and its row always read `+0 −0`.
  Two separate causes: libgit2 emits the delta for an untracked file but not
  its content unless `show_untracked_content` is set, so nothing was ever
  counted; and `@pierre/diffs` only computes a diff when *both* sides are
  non-null, so handing it a file with no HEAD side left it with nothing to
  draw. Deleted files had the mirror-image problem. Both sides now fall back
  to an empty file, giving the all-added / all-deleted rendering.
- **Diff rows that can't render one now offer a way out.** Binary, over
  512 KB, or missing used to be a dead-end line of grey text; it now sits
  next to a button per installed app, so a file too big to diff is one click
  from opening in nvim, VS Code or Finder.
- **`git_summary` folded into `git_status`.** The panel invoked both on every
  refresh and each one ran the full status walk, so a project with submodules
  opened every repo twice per keystroke-triggered debounce.

### Fixed
- **Dropped paths with spaces no longer reach Claude backslash-escaped**
  ([#69](https://github.com/willywg/klaudio-panels/issues/69)).
  `buildDropPayload` escaped spaces for every drop target, so dragging
  `CAMBIOS 5 AGOSTO.docx` onto a Claude tab typed `CAMBIOS\ 5\ AGOSTO.docx` —
  and Claude's prompt is prose, not a command line, so the backslash is a
  literal character and the path names a file that doesn't exist. Quoting is
  now chosen by target: Claude gets the raw path, the shell gets POSIX
  single-quoting (which also fixes `CAMBIOS (1).docx` and `it's here.txt`,
  broken words that escaping spaces alone never covered).
- **Terminal editor no longer comes back blank after a project switch**
  ([#68](https://github.com/willywg/klaudio-panels/issues/68)). `EditorPtyView`
  is mounted from a per-project list, so switching project unmounted it while
  `nvim` kept running — and its `onCleanup` disposed the terminal and dropped
  the PTY subscription, discarding every byte the editor emitted while you were
  away. Worse, the remount re-ran `spawnPty` on the *same* id: neither side
  guarded it, `sessions.insert` replaced the entry without killing the previous
  child, and two (then three) editors interleaved bytes into one
  `pty:data:<id>` channel — the garbled pane. Editor terminals now live in
  `editor-terminal-store`, keyed by ptyId, outliving the view and staying
  subscribed for the PTY's whole lifetime; the view only owns the DOM slot and
  repaints from the intact buffer on re-attach. Both `spawnPty` and Rust's
  `spawn_pty` now refuse a duplicate id.
- **Editor panel no longer gets stuck on screen after you close it**
  ([#66](https://github.com/willywg/klaudio-panels/issues/66)). With an
  inline-edit tab open, closing the panel (or going Home, or switching
  project) could leave the editor painted on top of everything — no tab
  strip, no close button, surviving project switches until the app was
  restarted. `<Show>`'s callback child receives an accessor that *throws*
  `Stale read from <Show>.` once the condition turns falsy; `App.tsx` passed
  it down as `DiffPanel`'s `projectPath`, and `EditorTab` read it back in
  `onCleanup` to unregister its edit buffer — i.e. exactly during teardown.
  Solid answers a throw inside an update batch by discarding every effect
  still queued behind it, so the `visibility: hidden` meant for the project
  layer never landed and the panel was never detached. The orphan stayed
  *visible* because the tab overlays hardcoded `visibility: visible`, which
  overrides a hidden ancestor. Three changes: `EditorTab` snapshots its
  `(projectPath, relPath)` at creation (which also stops it unregistering
  under the *next* project's key after a switch), `App.tsx` passes the
  project path read from the signal instead of the accessor, and the
  overlays now leave `visibility`/`pointer-events` unset when active so a
  hidden ancestor always wins.

### Tracked work
- PRP: [`PRPs/021--image-preview-and-terminal-thumbnails.md`](PRPs/021--image-preview-and-terminal-thumbnails.md)
- PRs: [#67](https://github.com/willywg/klaudio-panels/pull/67),
  [#70](https://github.com/willywg/klaudio-panels/pull/70),
  [#72](https://github.com/willywg/klaudio-panels/pull/72),
  [#74](https://github.com/willywg/klaudio-panels/pull/74),
  [#76](https://github.com/willywg/klaudio-panels/pull/76)
- Issues: [#66](https://github.com/willywg/klaudio-panels/issues/66),
  [#68](https://github.com/willywg/klaudio-panels/issues/68),
  [#69](https://github.com/willywg/klaudio-panels/issues/69),
  [#71](https://github.com/willywg/klaudio-panels/issues/71),
  [#73](https://github.com/willywg/klaudio-panels/issues/73),
  [#75](https://github.com/willywg/klaudio-panels/issues/75)

## [1.9.1] — 2026-07-29

### Fixed
- **Closing a tab now actually terminates the Claude process**
  ([#63](https://github.com/willywg/klaudio-panels/pull/63)). `pty_kill`
  only dropped the PTY master and trusted the resulting SIGHUP to be fatal,
  but Claude Code installs its own SIGHUP handler — so closing a tab could
  leave `claude` running indefinitely in the background, invisible to the
  user and holding its memory. One machine was found carrying six such
  processes parented to a running app, two of them two days old. The child
  is now force-terminated (SIGHUP, ~250ms grace, then an unconditional
  SIGKILL). The kill is guarded by a `try_wait` check under the same lock,
  so closing a tab whose process already exited on its own can never signal
  a PID the OS has since recycled to an unrelated process. Note that only
  the direct child is reaped; MCP servers and Bash-tool grandchildren
  survive until a process-group kill lands.
- **Sessions list sorts by last activity, not creation time**
  ([#65](https://github.com/willywg/klaudio-panels/pull/65)). `SessionMeta`
  carried a single timestamp — the first user message — so a months-old
  session you resumed and worked on today sorted *below* one created
  yesterday and never touched again. It now tracks `created_at` (first
  message, immutable) and `updated_at` (latest event in the JSONL tail,
  falling back to file mtime) separately, and the list sorts by
  `updated_at`, with `created_at` and the session id as deterministic
  tie-breakers so equal timestamps don't reshuffle between refreshes.
  Timestamps are canonicalized to UTC before comparison — sessions written
  under different offsets or fractional-second precision previously sorted
  wrong when compared as raw strings. The watcher also shares one bounded
  tail read between `updated_at` and completion detection instead of
  reading the file twice per tick.
- **`cargo clippy -- -D warnings` passes on Linux**
  ([#62](https://github.com/willywg/klaudio-panels/pull/62)).
  `std::process::Command` was imported unconditionally in `open_in.rs` but
  only used from macOS-gated code, so the unused-import lint failed the
  build on Linux. The import is now gated to macOS alongside its only use.
  No behavior change on macOS.

### Tracked work
- PRs: [#62](https://github.com/willywg/klaudio-panels/pull/62),
  [#63](https://github.com/willywg/klaudio-panels/pull/63),
  [#65](https://github.com/willywg/klaudio-panels/pull/65) — the project's
  first external contributions, all by
  [@reissaavedra](https://github.com/reissaavedra).

## [1.9.0] — 2026-07-20

### Added
- **Rendered markdown mode in the file preview**
  ([#58](https://github.com/willywg/klaudio-panels/issues/58)). Markdown
  previews now default to a GitHub-style rendered view: hard-wrapped source
  lines flow into paragraphs that reflow to the panel width, with headings,
  lists, tables, blockquotes, and Shiki-highlighted code fences. A floating
  button in the preview (or `Cmd+Shift+M`) toggles back to the source view —
  the preference is global and persisted. `Cmd+click` line jumps still land
  in Source (Rendered has no line numbers), absolute links open in the
  system browser, and all HTML is sanitized with DOMPurify before it touches
  the DOM.
- **Home screen: project avatars + filter box**
  ([#56](https://github.com/willywg/klaudio-panels/issues/56)). Each row in
  Recent projects now shows the project's avatar tile — same initials
  (including the per-project rename override) and deterministic color as the
  sidebar. A search box above the list filters by name, path, or initials as
  you type; Enter opens the first match, Esc clears. The box is focused
  automatically when the home screen appears.

- **Soft wrap for prose files in the file preview**
  ([#54](https://github.com/willywg/klaudio-panels/issues/54)). Markdown and
  plain-text files (`md`, `markdown`, `mdx`, `txt`) now wrap long lines
  downward with a hanging indent aligned after the line-number gutter,
  instead of forcing horizontal scroll. Code files keep `pre` + horizontal
  scroll so indentation stays intact.
- **Keyboard shortcuts to switch tabs within a project**
  ([#52](https://github.com/willywg/klaudio-panels/issues/52)). `Cmd+Opt+1..8`
  jumps to the Nth tab of the active project and `Cmd+Opt+9` to the last one —
  the within-project mirror of the `Cmd+1..9` project switcher (iTerm2's
  window/tab convention). `Ctrl+Tab` / `Ctrl+Shift+Tab` cycles next/previous
  tab, browser-style, on any keyboard layout. Both combos are swallowed
  before reaching the PTY, so `Ctrl+Shift+Tab` no longer risks leaking a
  `Shift+Tab` into Claude's permission-mode toggle.

### Fixed
- **Opening a project with huge session files no longer freezes the app**
  ([#60](https://github.com/willywg/klaudio-panels/issues/60)). Projects
  carrying hundreds of MB of `~/.claude/projects` JSONLs (one real case:
  561MB, largest session 334MB) hard-froze the UI for minutes — macOS showed
  "Application not responding". Two causes, both fixed: the
  `list_sessions_for_project` command was synchronous, which Tauri v2 runs
  on the main thread (now async + `spawn_blocking`), and the sidebar scan
  fully JSON-parsed every line of every session file (now a cheap substring
  gate skips the giant user/assistant lines once the preview is settled).
  The watcher's completion detector also stops reading whole files into
  memory — it inspects only a bounded 4 MiB tail.
- **Buttons show a pointer cursor**. Tailwind's preflight leaves buttons on
  the OS default arrow cursor; a global rule now opts every enabled button
  into `cursor: pointer` (first noticed on the markdown preview toggle).
- **Home screen list is scrollable again**
  ([#56](https://github.com/willywg/klaudio-panels/issues/56)). The
  recent-projects list was clipped with no way to scroll: the screen's root
  div relied on `flex-1` inside a non-flex absolute layer, so it grew with
  content and its `overflow-y-auto` never engaged, while `justify-center`
  clipped the top of the overflow. Now the root is `h-full` and the column
  centers via `margin: auto`, which collapses to 0 when content is taller
  than the viewport so the list scrolls from the first row.
- **Closing a project now actually shows its confirmation dialog**
  ([#50](https://github.com/willywg/klaudio-panels/issues/50)). The sidebar's
  close flow called the browser-global `confirm()`, which Tauri routes to
  `plugin:dialog|confirm` — a command our capability file never permitted, so
  every attempt was rejected by the ACL (`dialog|confirm not allowed by ACL`)
  and logged as an unhandled rejection. Worse, `confirm()` returns a Promise
  under Tauri, so the synchronous `if (confirm(msg))` guard was always truthy
  and the project closed with no prompt at all. Fixed by granting
  `dialog:allow-confirm` and awaiting the async `confirm()` so the guard
  genuinely gates the close. Pre-existing since 2026-04-24; unrelated to the
  v1.8.0 avatar work.

### Tracked work
- PRs: [#51](https://github.com/willywg/klaudio-panels/pull/51),
  [#53](https://github.com/willywg/klaudio-panels/pull/53),
  [#55](https://github.com/willywg/klaudio-panels/pull/55),
  [#57](https://github.com/willywg/klaudio-panels/pull/57),
  [#59](https://github.com/willywg/klaudio-panels/pull/59),
  [#61](https://github.com/willywg/klaudio-panels/pull/61)
- Issues: [#50](https://github.com/willywg/klaudio-panels/issues/50),
  [#52](https://github.com/willywg/klaudio-panels/issues/52),
  [#54](https://github.com/willywg/klaudio-panels/issues/54),
  [#56](https://github.com/willywg/klaudio-panels/issues/56),
  [#58](https://github.com/willywg/klaudio-panels/issues/58),
  [#60](https://github.com/willywg/klaudio-panels/issues/60)

## [1.8.0] — 2026-06-01

### Added
- **Two-letter project avatar initials, with per-project override**
  ([#47](https://github.com/willywg/klaudio-panels/pull/47)). Avatars
  in the projects sidebar now show two characters by default — multi-word
  names like `platform-two` or `myCoolApp` use the first letter of each
  word (`PT`, `MC`); single-word names take the first two letters
  (`Perfil` → `PE`). Right-click an avatar → **Rename initials…** opens a
  small dialog to set a custom 1–3 character override (auto-uppercased,
  Enter to save, Esc to cancel, **Reset** to fall back to the auto value).
  The override is persisted in `localStorage` alongside the rest of
  `recentProjects` and survives reload. Existing entries without an
  override migrate transparently. Contributed by
  [@adancondori](https://github.com/adancondori).

### Changed
- Avatar font size auto-shrinks from `13px` to `11px` when the initials
  are 3 characters so they don't overflow the 40×40 tile.
- Right-clicking an avatar now opens a controlled context menu
  (Rename initials… / Close project) instead of suppressing the native
  one outright. Close still requires confirmation, preserving the
  destructive-by-accident guard from the previous behavior.

### Tracked work
- PR: [#47](https://github.com/willywg/klaudio-panels/pull/47)
  (no prior issue — drive-by contribution)
- Follow-ups: [#48](https://github.com/willywg/klaudio-panels/issues/48)
  (emoji in avatar labels), [#49](https://github.com/willywg/klaudio-panels/issues/49)
  (custom image/logo avatar, OpenCode-style)

## [1.7.1] — 2026-05-18

### Added
- **Clickable bare-domain URLs in the terminal**
  ([#45](https://github.com/willywg/klaudio-panels/issues/45)). Scheme-less
  URLs that Claude commonly emits — `app.constructai.la`,
  `linear.app/foo/bar`, `github.com/user/repo` — now hover-underline and
  ⌘+click opens them in the system browser as `https://<host>/<path>`.
  Wired into all three terminal surfaces (Claude PTY, shell PTY, editor
  PTYs). A small TLD allowlist (com|org|net|io|dev|app|ai|co|la +
  common country codes) keeps file extensions like `.ts` / `.json` /
  `.html` out of the URL path — extending the list is cheap when a
  case shows up. Side effect: a long-standing false positive is gone
  — the file-link provider's greedy regex used to match
  `app.constructai.la` as the "file" `app.constructai` with `.la`
  "extension", which silently sent ⌘+click to the diff panel for a
  non-existent path.

### Fixed
- **`openUrl` failures now land in `klaudio.log`**
  ([#45](https://github.com/willywg/klaudio-panels/issues/45)).
  `src/lib/open-url.ts` used `console.warn` on rejection, which
  `installGlobalErrorForwarding` doesn't capture (it only forwards
  `window.error` + `window.unhandledrejection`). Any future opener
  regression — Tauri ACL change, NSWorkspace returning no-error for
  an unknown handler, scope misconfiguration — is now visible in
  `~/Library/Logs/Klaudio Panels/klaudio.log` as a
  `[JS:open-url] failed …` line, alongside the matching
  `[JS:open-url] attempt …` so we can tell whether the click reached
  the handler at all.

### Tracked work
- PRP: [`PRPs/020--bare-url-links-and-open-url-diagnostics.md`](PRPs/020--bare-url-links-and-open-url-diagnostics.md)
- PR: [#46](https://github.com/willywg/klaudio-panels/pull/46)
- Issue: [#45](https://github.com/willywg/klaudio-panels/issues/45)

## [1.7.0] — 2026-05-15

### Added
- **Inline file editor — quick "Edit" from the file tree**
  ([#34](https://github.com/willywg/klaudio-panels/issues/34)). A new
  `kind: "edit"` tab in the diff panel, backed by CodeMirror 6, opens
  in three ways: right-click a text file in the tree → **Edit**,
  right-click an existing preview tab → **Edit this file**, or ⌘E
  (falls back to the file-tree selection when no preview is active).
  Plain-text only, ≤1 MiB, strict UTF-8 — binaries and non-UTF-8 are
  rejected at the read step so the editor can't introduce U+FFFD
  replacements and then save them back, corrupting the file. ⌘S
  writes the file; the backend re-stats first and returns a
  `stale` result on `mtime_ms` mismatch, which the UI surfaces as a
  **Reload / Keep mine** banner so an external change doesn't get
  clobbered. Dirty indicator on the tab; close-guard prompts
  Save / Discard / Cancel, and awaits an in-flight save so ⌘S
  followed by an immediate close doesn't pop a spurious dialog.
  Lazy-loaded language packs for ~11 common languages — everything
  else opens as plain text.

### Changed
- **Editor + confirm-dialog palette aligned with `<FilePreview>`**.
  CodeMirror was using `defaultHighlightStyle` from
  `@codemirror/language` (dark red strings, blue identifiers, magenta
  keywords) which clashed with the github-dark-default tokens that
  `<FilePreview>` already renders via Shiki. Replaced with a custom
  HighlightStyle approximating the same palette: light blue strings,
  blue numbers, coral keywords, green property names + tags, purple
  function names, orange types, muted gray italic comments. The
  Save / Discard buttons in the confirmation dialog dropped their
  saturated indigo / red fills in favour of a subtler accent
  treatment — still semantically red-for-destructive and
  indigo-for-primary, just turned down to match the rest of the app.

### Tracked work
- PRP: [`PRPs/019--inline-file-editor.md`](PRPs/019--inline-file-editor.md)
- PR: [#35](https://github.com/willywg/klaudio-panels/pull/35)
- Issue: [#34](https://github.com/willywg/klaudio-panels/issues/34)
- Follow-up: [#44](https://github.com/willywg/klaudio-panels/issues/44) — consolidate inline editor under the "Open with" registry so ⌘+click can route to CodeMirror and the "three tabs for the same file" state disappears.

## [1.6.4] — 2026-05-15

### Added
- **Per-tab "needs attention" indicator**
  ([#42](https://github.com/willywg/klaudio-panels/issues/42)). When a
  project has more than one Claude tab and one of them fires a
  notification (`session:complete` or warp `permission_request`) while
  you're looking at a different tab, the tab strip now pulses amber
  on the offending tab. The project ring + bell + toast already said
  "this project needs you"; the amber dot closes the missing
  per-tab cue ("which tab needs me"). Single-tab projects suppress
  the pulse (no ambiguity). Pulse clears on tab activation, on user
  typing (covers the race where the flag fires on an already-active
  tab), and on tab close. Project switch deliberately does NOT
  clear — too coarse for a per-tab signal.

  The same payload threading lets the **toast and bell entries
  route to the originating tab**, not just the project. Clicking a
  toast that says "Project A · Claude is done" now lands you on the
  exact tab Claude finished in, regardless of which tab was active
  before. Cross-project clicks pre-mark `activeByProject` so the
  existing project-switch effect picks the target tab as the
  `nextActive`. Null-sessionId `permission_request` events (older
  warp builds <0.3.0) gracefully degrade — toast still appears,
  click activates the project without preselecting a tab, and no
  per-tab pulse is raised (a wrong-tab pulse would be worse than
  none).

  Respects existing per-channel kill switches
  (`notifySessionComplete`, `notifyPermission`): disabling a channel
  suppresses both the toast and the pulse.

### Tracked work
- PRP: [`PRPs/018--tab-needs-attention-indicator.md`](PRPs/018--tab-needs-attention-indicator.md)
- PR: [#43](https://github.com/willywg/klaudio-panels/pull/43)
- Issue: [#42](https://github.com/willywg/klaudio-panels/issues/42)

## [1.6.3] — 2026-05-11

### Fixed
- **Terminal focus race on project switch — both directions**
  ([#40](https://github.com/willywg/klaudio-panels/issues/40)). On
  project re-entry every visible panel's selected tab flipped
  `active=true` simultaneously, and each terminal view's activation
  effect called `term.focus()`. The last one to run owned the
  cursor: keystrokes intended for Claude went to whatever was
  running in the shell (including `npm run dev`) or vice-versa.

  Replaced with a single rule across all three terminal surfaces
  (Claude, shell, editor PTY): **focus is only triggered by an
  explicit user action or by per-project memory restoration on
  project switch. Visibility flips never decide focus.** A new
  module `src/lib/terminal-focus-bus.ts` (sibling of
  `terminal-scroll-bus`) holds a registry of focus callbacks keyed
  by PTY id plus `lastFocusedForProject` — updated by user-action
  handlers (Claude `+` / session-click / tab-click / auto-resume,
  shell `+` / tab-click, editor `Open in` / tab-click) and by a
  `focus` listener on each `term.textarea` that catches direct
  clicks on the xterm body. `App.tsx`'s project-switch effect
  calls `focusTerminal(lastFocusedForProject(p) ?? activeClaudeTab)`
  inside a `requestAnimationFrame` so the cursor lands in whichever
  terminal the user was last using in that project.

### Tracked work
- PRP: [`PRPs/017--fix-focus-steal-on-project-switch.md`](PRPs/017--fix-focus-steal-on-project-switch.md)
- PR: [#41](https://github.com/willywg/klaudio-panels/pull/41)
- Issue: [#40](https://github.com/willywg/klaudio-panels/issues/40)

## [1.6.2] — 2026-05-03

### Fixed
- **Terminal scroll drift + welcome banner re-appearing on project
  switch** ([#38](https://github.com/willywg/klaudio-panels/issues/38)).
  The activation effect ran three fits at rAF + 180ms + 500ms (plus
  two `term.refresh()` calls). FitAddon already short-circuits no-op
  fits internally, so on a settled layout the stages were harmless —
  but on a project switch the outer layout reflows asynchronously
  (per-project sidebar width, panelLayout memo, diff panel
  auto-show/hide). Each stage caught a different intermediate width,
  each one passed FitAddon's dimensions-changed guard, each one fired
  a real SIGWINCH and forced Claude to redraw the alt-screen. Three
  SIGWINCHes within 500ms confused xterm's buffer state: scroll
  drifted upward (wrapped-line reflow shifted `viewportY`), and in
  worse cases the previous-screen scrollback (which holds Claude's
  startup banner) leaked through the alt-screen mid-stream.

  Replaced with one immediate `term.refresh()` (handles the WebGL
  stops-painting-while-hidden case when fit ends up being a no-op)
  plus one `safeFit` at 250ms, after the layout has settled. Claude
  now receives at most one SIGWINCH per activation.

### Tracked work
- PRP: [`PRPs/016--terminal-activation-resize.md`](PRPs/016--terminal-activation-resize.md)
- PR: [#39](https://github.com/willywg/klaudio-panels/pull/39)
- Issue: [#38](https://github.com/willywg/klaudio-panels/issues/38)

## [1.6.1] — 2026-05-02

### Fixed
- **Notification spam from `session:complete` is now opt-out, not
  forced** ([#36](https://github.com/willywg/klaudio-panels/issues/36)).
  The JSONL watcher emits `session:complete` once per Claude
  `end_turn`, and Claude reaches `end_turn` after every tool-free
  reply — which means the bell flooded with "Claude is done" entries
  during long agentic loops. Affects everyone, not just users without
  the warp plugin. A community user hit it almost immediately on
  v1.6.0.

### Added
- **Per-channel notification kill switch.** Bell → ⚙️ Settings panel
  with three independent toggles, persisted in `localStorage`:
  - **Task complete** — gates `session:complete` (the noisy one).
  - **Permission requests** — gates `permission_request` from the
    warp plugin.
  - **Sounds** — gates both chimes; toasts/banners/bell still appear.

  Toggles default ON to preserve v1.6.0 behavior. Disabling a channel
  short-circuits at the entry point: zero side effects (no toast, no
  bell entry, no banner, no chime, no amber ring).

- **Plugin-aware Permission row.** The Permission toggle is
  auto-disabled and visually OFF when the warp/claude-code-warp
  plugin isn't installed (no events would arrive anyway). Helper text
  swaps for an **Install →** link that opens the README anchor in the
  system browser. The persisted pref is preserved through the
  disabled/enabled transition — install the plugin and the row
  activates with the user's last saved choice.

  Detection runs through a new `is_warp_plugin_installed` Tauri
  command that reads `~/.claude/plugins/installed_plugins.json`. State
  refreshes on every settings-view open, so installing the plugin
  without restarting Klaudio works.

### Changed
- **README**: bumped the warp plugin recommendation to the top of the
  Notifications section since `permission_request` is the higher-
  signal channel. Built-in transcript-watcher path now framed as the
  fallback for users who can't install the plugin.

### Tracked work
- PRP: [`PRPs/015--notification-preferences.md`](PRPs/015--notification-preferences.md)
- PR: [#37](https://github.com/willywg/klaudio-panels/pull/37)
- Issue: [#36](https://github.com/willywg/klaudio-panels/issues/36)

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
