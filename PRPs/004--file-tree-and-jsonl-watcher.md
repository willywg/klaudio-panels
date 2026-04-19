# PRP 004 — File tree + JSONL watcher (with Sessions/Files sidebar tabs)

> **Version:** 1.0
> **Created:** 2026-04-19
> **Status:** Draft
> **Phase:** Sprint 03 (PROJECT.md Phase 2 — filesystem reactivity)

---

## Scope note (read first)

This PRP bundles three tightly-coupled pieces that share filesystem-reactivity infrastructure:

1. **Sidebar panel refactor** — the existing 280px `<aside>` gets two tabs (Sessions | Files) below the project title, plus a collapse/expand affordance.
2. **File tree** — lazy-loaded project tree backed by the `notify` crate, with `.gitignore` honored via the `ignore` crate.
3. **JSONL watcher** — filesystem watcher over `~/.claude/projects/<encoded>/*.jsonl` that (a) propagates `/rename` (custom-title) and summary changes to open tab labels and sessions-list previews live, and (b) correlates "new" tabs (opened without `--resume`) with their real `sessionId` once Claude writes the first JSONL line.

**Out of scope (will be PRP 005):** "Activity panel" showing which files Claude is currently editing (requires parsing `tool_use` from JSONL lines — different API surface).

**Out of scope (will be Sprint 04):** diff viewer, file content preview, open-in-editor.

---

## Goal

The 280px left panel becomes a two-tab surface: `Sessions` (current behavior) and `Files` (new). The `Files` tab shows a VS Code / Warp-style tree of the active project, lazy-loaded on expand, reactive to filesystem changes (create / rename / delete propagate without a manual refresh). A collapse button shrinks the whole panel to a 12px rail; clicking the rail (or Cmd+B) re-expands it. In parallel, a JSONL watcher runs in the background: when the user types `/rename` inside a Claude tab, its tab label and sidebar entry update live; when the user opens a brand-new tab (no `--resume`) and Claude writes the first JSONL line, the tab gets its real `sessionId` attached — so the sidebar correctly shows it as "open" and `lastSessionId` persistence works for fresh sessions.

## Why

- **File tree next to the terminal closes the loop on "what's Claude doing to my repo?"** Sprint 02 gave multi-session; Sprint 03 gives context on the working tree. Without a tree, the user has to alt-tab to Finder/iTerm to see new files.
- **Tabbed sidebar avoids panel proliferation.** Adding a third column for files would eat horizontal space on 13" laptops. Warp's pattern (tab switcher in the same panel) is a proven solution.
- **Collapse button recovers terminal width** when the user is focused on the conversation. One-key reclaim of ~280px matters on small screens.
- **JSONL watcher is unavoidable infrastructure.** Two Sprint-02 limitations only close with it: (a) `/rename` is invisible until the user closes and reopens the tab, (b) "new" tabs live with `sessionId: null` forever, breaking sidebar indicators and last-session persistence for non-resumed sessions.
- **Filesystem is the source of truth (CLAUDE.md rule #7).** No custom index, no DB, no PTY parsing.

## What

### User-visible behavior

**Sidebar (280px `<aside>`):**
1. Project title block stays at the top (unchanged).
2. Directly below it: a tab strip with two tabs — **Sessions** (default) and **Files**. Active tab has a subtle indigo underline; hover changes text color.
3. A collapse button (chevron pointing left) sits at the right edge of the tab strip.
4. Clicking collapse → the whole aside animates to a **36px rail** with a vertical chevron pointing right, plus two tiny stacked icons (Sessions / Files) that act as shortcuts to expand-into-that-tab. Clicking the chevron or any icon → expands back. 36px (not 12px) chosen to match Warp's discoverability — a 12px rail is too easy to miss.
5. `Cmd+B` (macOS) toggles collapsed state from anywhere in the window.
6. Collapsed state is **global** (one state shared across projects), persisted in `localStorage["sidebarCollapsed"]`.
7. Active tab (Sessions vs Files) is **per-project**, persisted in `localStorage["sidebarTab:<projectPath>"]`. Default: `Sessions`.

**Files tab:**
8. Shows a tree rooted at the project path, first level loaded eagerly when the tab is first opened for that project.
9. Directories are collapsible (chevron + folder icon). Files have a file-type icon.
10. Expanding a directory lazy-loads its children (single Tauri call; cached in Rust).
11. Hidden files (starting with `.`) and `.gitignore`-matched entries are hidden by default (Sprint 03 doesn't add a toggle yet).
12. Right-click on a file/folder shows a context menu: **Copy path**, **Reveal in Finder** (calls `tauri-plugin-opener`).
13. Single-click selects an entry (indigo left border). No double-click action in Sprint 03 (diff viewer is Sprint 04).
14. New / renamed / deleted files appear / update / disappear without a manual refresh (debounced ~150ms).

**JSONL watcher (background, no new UI):**
15. When a tab is active and the user runs `/rename` inside Claude Code, the new title appears in the tab strip label and in the sessions-list preview within ≤500ms.
16. When a "new" tab (opened with `[]` args, `sessionId: null`) produces its first JSONL line, the tab's `sessionId` is set in the `TerminalStore`. The sidebar's "open session" indicator (green dot / border) now lights up for that session.
17. `lastSessionId` persistence works for promoted "new" tabs: closing and reopening the app auto-resumes a previously-new-but-now-identified session.

### Success Criteria

- [ ] Toggling between Sessions/Files tabs does not unmount the terminal section.
- [ ] Active tab is remembered per-project (switch project A→B→A, Files stays selected if that's what was chosen).
- [ ] Collapsed state persists across app restarts.
- [ ] `Cmd+B` toggles the panel regardless of focus.
- [ ] Expanding a directory with 1000+ files returns in <300ms (lazy-load works).
- [ ] Creating a file in Finder appears in the tree within 300ms without clicking refresh.
- [ ] Deleting a file removes it from the tree without a stale entry.
- [ ] `.gitignore`'d files (e.g. `node_modules/`, `dist/`) are not listed.
- [ ] Typing `/rename New Title` in an active Claude tab: label updates within 500ms.
- [ ] Opening a "new" tab and sending one message: tab's `sessionId` gets set; sidebar shows it as open; closing+reopening the app auto-resumes it.
- [ ] No regression: Sprint 02 multi-tab + auto-resume still works identically.
- [ ] `bun run typecheck`, `cargo check`, `cargo clippy -- -D warnings` all clean.

---

## All Needed Context

### Project-level references (always relevant)
```yaml
- file: PROJECT.md
  why: Phase 2 (filesystem reactivity) scope and Sprint 03 decomposition.
- file: CLAUDE.md
  why: Rule #2 (don't parse PTY output), Rule #5 (JSONL is source of truth for sessions), Rule #7 (filesystem + git are source of truth for file state).
- file: docs/sprint-02-results.md
  why: Known limitations this PRP closes (new-tab sessionId correlation, live /rename).
```

### Feature-specific documentation & references
```yaml
# Rust crates (versions verified 2026-04-19 on crates.io)
- url: https://docs.rs/notify/8.2.0/notify/
  why: Cross-platform filesystem watcher. macOS uses FSEvents.
  version: "8"
  critical: Use notify-debouncer-full, NEVER raw notify::Watcher — hand-rolling debounce is the #1 source of flaky tests in fs-watcher code.

- url: https://docs.rs/notify-debouncer-full/0.6.0/notify_debouncer_full/
  why: Adds proper debouncing + event coalescing on top of notify. API: `new_debouncer(timeout, tick_rate, event_handler)`.
  version: "0.6"
  critical: MSRV is 1.85 — check src-tauri/rust-toolchain if pinned below that.

- url: https://docs.rs/ignore/latest/ignore/
  why: ripgrep's gitignore engine. Respects nested .gitignore, global gitignore, and hidden files.
  critical: WalkBuilder.hidden(true) also hides dotfiles. Combine with .gitignore(true) + .git_global(true).

# Tauri plugins (already installed or trivial to add)
- url: https://v2.tauri.app/plugin/opener/
  why: tauri-plugin-opener (already a dep) exposes `revealItemInDir(path)` which opens Finder/Explorer/file-manager with the target selected. No need for tauri-plugin-shell + `open -R`.
  permission: `opener:allow-reveal-item-in-dir` in capabilities/default.json.

# Claude Code Channels (NOT applicable to Sprint 03 — documented for future)
- url: https://code.claude.com/docs/en/channels-reference
  why: Channels are one-way MCP servers that push events INTO Claude sessions (chat bridges, webhook receivers, permission relay). They do NOT expose outbound events from Claude (rename, tool-use, session-started) — direction is inverted from what we need for the JSONL watcher. Noted here so we don't revisit. Future PRP 00X could use the permission-relay API to surface Claude's "allow Bash/Write?" prompts as native macOS dialogs instead of TUI, but that's orthogonal to file tree + JSONL tailer.

# Existing code — reusable
- file: src-tauri/src/sessions.rs
  why: JSONL parser for SessionMeta. Extend (not rewrite) to support incremental scanning from a byte offset for the tailer.
  lines: 48-140

- file: src/components/sessions-list.tsx
  why: Content of the "Sessions" tab. Unchanged semantically; lives inside a tab-switcher now.

- file: src/components/terminal-view.tsx
  why: Listens to pty:data:<id>. Does NOT need to change — the JSONL watcher runs in parallel.

- file: src/App.tsx
  why: `<aside>` in lines 344-372 is the refactor point for the sidebar tabs and collapse.

# Reference repos
- file: ~/proyectos/open-source/opencode/packages/app/src/components/file-tree/*
  why: Lazy-load tree pattern, row virtualization (if they have it — check before copying).
  note: They also hit notify via Rust; spot-check their watcher.rs for debounce interval.
  don't_copy: Their icon mapping if it depends on their theme tokens — we use Tailwind + lucide-solid.

- file: ~/proyectos/open-source/opencode/packages/desktop/src-tauri/src/fs.rs  (if present)
  why: Tauri fs commands layout (list_dir, stat, watch_dir).
```

### Current repo state (relevant portions)
```
src-tauri/src/
├── binary.rs
├── lib.rs              # invoke_handler registration
├── pty.rs
├── sessions.rs         # JSONL reader, one-shot
└── shell_env.rs

src/
├── App.tsx             # <aside> holds project title + SessionsList
├── components/
│   ├── sessions-list.tsx
│   ├── tab-strip.tsx   # terminal tabs (unrelated to sidebar tabs)
│   ├── projects-sidebar.tsx
│   └── ...
└── context/
    ├── projects.tsx
    └── terminal.tsx
```

### Desired changes (files to add/modify)
```
src-tauri/
├── Cargo.toml                          # MODIFY: + notify = "8", notify-debouncer-full = "0.6", ignore = "0.4"
└── src/
    ├── lib.rs                          # MODIFY: register new commands + events
    ├── fs.rs                           # NEW: list_dir, watch_project, emit fs:event:<projectPath>
    └── session_watcher.rs              # NEW: watch ~/.claude/projects/<encoded>/*.jsonl; emit session:meta:<projectPath> and session:new:<projectPath>

src/
├── App.tsx                             # MODIFY: replace <aside> body with SidebarPanel
├── context/
│   ├── sidebar.tsx                     # NEW: { activeTab, collapsed, setActiveTab, toggleCollapsed }
│   └── session-watcher.tsx             # NEW: listens for session:meta + session:new; updates tabs + refresh signal
├── components/
│   ├── sidebar-panel.tsx               # NEW: wrapper with tabs + collapse + content
│   ├── sidebar-tabs.tsx                # NEW: tiny Sessions|Files tab row
│   ├── file-tree/
│   │   ├── file-tree.tsx               # NEW: tree root + scroll container + watcher wiring
│   │   ├── tree-node.tsx               # NEW: one row (chevron + icon + name + context menu)
│   │   └── use-file-tree.ts            # NEW: store + lazy load + fs event reducer
│   └── context-menu.tsx                # NEW (small): headless Kobalte-free menu; fixed position, click-outside closes
└── lib/
    ├── sidebar-prefs.ts                # NEW: localStorage helpers (collapsed, active tab per project)
    └── file-icon.ts                    # NEW: maps extension → lucide-solid icon name

src-tauri/capabilities/default.json     # MODIFY: allow new invoke names + event listens
```

### Known gotchas & project rules
```
CRITICAL — CLAUDE.md rules (do not re-propose):
- Don't parse the PTY output to detect /rename. Read the JSONL instead.
- Don't write to ~/.claude/projects/. Read-only.
- No SQLite for tree state. Memoize in Rust HashMap; it's ephemeral.

notify / FSEvents:
- macOS FSEvents emits events for the *directory*, not per-file. A single "save" on
  a text editor can fire 3-5 events (tmp write, rename, chmod). Debounce 150ms.
- notify-debouncer-full v0.3+ exposes `DebouncedEvent` with `kind: EventKind` and
  a `time: Instant`. Emit to frontend ONLY after the debounce window closes.
- Watcher scope: RecursiveMode::Recursive on the project root. But .gitignore'd
  paths still generate events — filter them on the Rust side BEFORE emitting, or
  node_modules will flood the channel when bun install runs.

ignore crate:
- WalkBuilder::new(path).max_depth(Some(1)).hidden(true).git_ignore(true).build()
  for lazy-load: children of one directory only.
- .gitignore is re-parsed every call — cheap at small depths, but for repeated
  expansions of the same dir, cache the result keyed by (path, gitignore mtime).
  If mtime check is overkill for v1, skip caching; benchmark first.

JSONL tailer race (the non-obvious part — empirically verified 2026-04-19):
- Opening a "new" tab (claude with no --resume): Claude writes the first JSONL
  line some time after the PTY starts. We checked real JSONLs: file birth-time
  does NOT reliably match either spawn-time or first-user-input time (observed
  drift of several minutes on resumed sessions, and the first line is often a
  `permission-mode` or `attachment` with no timestamp). So we CAN'T correlate
  deterministically by timestamps alone.
- Revised strategy (FIFO queue with sanity guard):
    1. Frontend keeps a FIFO queue of "new" tabs awaiting correlation, ordered
       by spawnedAt ascending.
    2. On `session:new` event from Rust (fires when a brand-new JSONL appears
       under an encoded dir matching any project with a pending tab):
         - Pop the OLDEST pending tab for that project_path.
         - Sanity guard: reject if jsonl_created_at_ms + 30s < spawnedAt (way
           off — likely a session created by another tool, not our tab).
         - Otherwise: promote (tab.sessionId = payload.session_id, update label).
    3. Use JSONL creation (not modification) events to emit session:new — Rust
       tracks seen-before paths in a HashSet; first sighting of an unseen path
       triggers `session:new`. Subsequent writes trigger `session:meta` only.
- Known edge case (documented, accepted): user opens tab A, waits 10s, opens
  tab B, then types first in B. B's JSONL is created first → FIFO pops A →
  A gets B's sessionId. Workaround: user can manually close and reopen the
  tabs, or we add a "Refresh" button (out of scope). Rare in practice.
- Rationale for FIFO over stricter heuristic: "at most one new-tab per project
  at a time" is the common case. When users open 2+ concurrently, they
  typically interact with them in open order. FIFO is right 95% of the time
  and never crashes.
- Claude Code's JSONL format has NO session-start marker in the first line
  (verified via inspection of ~/.claude/projects/). We can't use the PTY
  output either (CLAUDE.md rule #2). FIFO is the least-bad option.

/rename propagation:
- session_watcher.rs sees `{"type":"custom-title","customTitle":"..."}` appended
  to an existing JSONL. Re-scan THAT file only (not the whole project) and emit
  `session:meta:<projectPath>` with full updated SessionMeta.
- Frontend updates: (a) tab.label if tab.sessionId matches, (b) sessions-list
  cache if visible.
- Don't emit per-line; emit after each file-modified debounce tick.

Sidebar persistence:
- Collapsed: "sidebarCollapsed" → "1" | missing. Global.
- Active tab: "sidebarTab:<projectPath>" → "sessions" | "files". Default "sessions".
- Failure modes: projectPath with unusual chars (spaces, emoji) still works for
  localStorage; no escaping needed.

SolidJS quirks:
- Don't use createResource for the tree — it re-runs on key change, which is
  fine for one-shot but throws away nested expanded-state. Use a manual store
  keyed by absolute path.
- For the tree's reactive updates on fs events, use setStore with produce +
  path-based mutation. Re-rendering the whole tree on every event is a perf
  trap once the tree has 1000+ nodes.

Tauri capabilities:
- New commands to add: list_dir, watch_project, unwatch_project, watch_sessions,
  unwatch_sessions, reveal_in_finder (if we use opener; check plugin name).
- New events to allow: `fs:event:*`, `session:meta:*`, `session:new:*`.
- capabilities/default.json must grant "core:event:allow-listen" for each glob.
```

---

## Implementation Blueprint

### Data models / types

```ts
// src/context/sidebar.tsx
export type SidebarTab = "sessions" | "files";
export type SidebarState = {
  activeTabByProject: Record<string, SidebarTab>;
  collapsed: boolean;
};

// src/components/file-tree/use-file-tree.ts
export type TreeNode = {
  path: string;          // absolute
  name: string;
  isDir: boolean;
  size: number | null;
  // Tree-only state:
  expanded: boolean;     // directories only
  loaded: boolean;       // directories: children have been fetched at least once
  children: TreeNode[];  // only populated if loaded
};

export type FsEvent =
  | { kind: "created"; path: string; is_dir: boolean }
  | { kind: "modified"; path: string }
  | { kind: "removed"; path: string }
  | { kind: "renamed"; from: string; to: string };

// src/context/terminal.tsx — add spawnedAt to TerminalTab
export type TerminalTab = { /* existing */ spawnedAt: number };
```

```rust
// src-tauri/src/fs.rs
#[derive(serde::Serialize, Clone)]
pub struct FsEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FsEventPayload {
    Created { path: String, is_dir: bool },
    Modified { path: String },
    Removed { path: String },
    Renamed { from: String, to: String },
}

// src-tauri/src/session_watcher.rs
#[derive(serde::Serialize, Clone)]
pub struct SessionNewPayload {
    pub project_path: String,
    pub session_id: String,
    pub jsonl_created_at_ms: u64,
    pub preview: Option<String>,
}
```

### Tasks (in execution order)

```yaml
Task 1: Sidebar context + persistence
  CREATE: src/lib/sidebar-prefs.ts
    - getCollapsed(): boolean
    - setCollapsed(v: boolean): void
    - getActiveTab(projectPath): SidebarTab
    - setActiveTab(projectPath, tab): void
  CREATE: src/context/sidebar.tsx
    - makeSidebarContext(): returns { activeTab: (path) => SidebarTab, setActiveTab,
      collapsed, toggleCollapsed }
  WIRING: wrap in src/App.tsx's SolidJS provider tree (outside Shell)
  KEYBIND: onMount in App — window.addEventListener('keydown', e => if (e.metaKey && e.key === 'b') { preventDefault; ctx.toggleCollapsed() })
  onCleanup: removeEventListener

Task 2: SidebarPanel + SidebarTabs components
  CREATE: src/components/sidebar-tabs.tsx
    - Horizontal strip below project title. Two buttons: Sessions, Files.
    - Active tab: indigo underline, neutral-100 text. Inactive: neutral-500.
    - Right edge: collapse chevron button (calls ctx.toggleCollapsed).
  CREATE: src/components/sidebar-panel.tsx
    - Outer wrapper. If collapsed: render a 12px vertical rail with expand chevron.
    - If expanded: render { projectTitle, SidebarTabs, content: sessions|files }.
    - Smooth width transition via Tailwind transition-[width] duration-150.
  MODIFY: src/App.tsx
    - Replace <aside>...SessionsList</aside> with <SidebarPanel activeProjectPath=...>.
    - <SidebarPanel> internally switches on ctx.activeTab(projectPath).

Task 3: Rust fs.rs — list_dir + watcher
  ADD to Cargo.toml:
    notify = "8"
    notify-debouncer-full = "0.6"
    ignore = "0.4"
  CREATE: src-tauri/src/fs.rs
    - list_dir(path: String) -> Result<Vec<FsEntry>, String>
      Uses ignore::WalkBuilder with max_depth(Some(1)), hidden(true),
      git_ignore(true). Returns one level only.
    - WatcherState: Arc<Mutex<LruCache<String, Debouncer<...>>>> keyed by project_path,
      capacity 3. Opening Files tab for a 4th project automatically evicts the LRU
      (the evicted watcher is dropped, which stops its thread). Rationale: each
      recursive watcher on a large repo costs ~5-15MB + one kqueue fd; 3 is
      enough for the 90th-percentile workflow of juggling projects.
    - watch_project(app: AppHandle, project_path: String) -> Result<(), String>
      Creates a debouncer (150ms), RecursiveMode::Recursive on project_path,
      filters out events inside .gitignore'd paths (re-check per event via
      ignore::gitignore::Gitignore::new(project_path/.gitignore)), emits
      fs:event:<project_path> payloads.
    - unwatch_project(project_path: String) -> Result<(), String>
      Removes from LRU (drops the debouncer).
  REGISTER: lib.rs invoke_handler + capabilities/default.json.
  TEST: manual — `bun tauri dev`, add a file via `touch`, observe console log
        in the frontend listener stub.

Task 4: File tree store + UI
  CREATE: src/components/file-tree/use-file-tree.ts
    - makeFileTreeStore(projectPath): returns { root: TreeNode, toggleDir(path),
      ensureLoaded(path), applyFsEvent(event) }
    - Internal store keyed by path (flat map) + root pointer for rendering.
    - toggleDir: if !loaded → invoke('list_dir', { path }); hydrate children; mark loaded; toggle expanded.
    - applyFsEvent:
        created: if parent.loaded, insert into parent.children (sorted: dirs first, then alpha)
        removed: if parent.loaded, splice out
        modified: update size if we show it (v1: skip)
        renamed: removed(from) + created(to) — avoids special-case logic
  CREATE: src/components/file-tree/tree-node.tsx
    - One row. Left padding = depth * 12px.
    - Chevron for dirs (rotates 90deg on expanded).
    - Icon: Folder / FolderOpen from lucide-solid for dirs; file-icon map for files.
    - onClick: select (local store). onContextMenu: open context menu.
  CREATE: src/components/file-tree/file-tree.tsx
    - Mounts on Files tab. ensureLoaded(root) on first mount per project.
    - invoke('watch_project', { projectPath }) on mount.
    - listen<FsEvent>(`fs:event:${projectPath}`, applyFsEvent); unlisten + invoke('unwatch_project') on cleanup.
    - Renders root.children as flat list of <TreeNode> (depth-first traversal of expanded subtree).
  CREATE: src/lib/file-icon.ts
    - mapExtToIcon(name): ".ts" -> "FileCode", ".md" -> "FileText", default "File".

Task 5: Context menu (Copy path / Reveal in Finder)
  CREATE: src/components/context-menu.tsx
    - Controlled by a signal { x, y, items } in file-tree.tsx.
    - items: [{ label, onClick }]. Click-outside via window listener + pointerdown capture.
  REVEAL: uses `@tauri-apps/plugin-opener.revealItemInDir(absolutePath)` — verified
          to exist in v2; opens Finder with the target file selected (not just
          the parent dir). No `tauri-plugin-shell` needed.
  PERMISSION: add `"opener:allow-reveal-item-in-dir"` to capabilities/default.json.

Task 6: Rust session_watcher.rs — JSONL tailer
  CREATE: src-tauri/src/session_watcher.rs
    - Global watcher on ~/.claude/projects/ (recursive) installed once at app boot
      (lib.rs run()). Debounce 200ms.
    - State: Arc<Mutex<HashMap<PathBuf, u64>>> — file → last-read-byte-offset.
      On modified event: open file, seek to offset, read appended lines, parse,
      advance offset.
    - For each event:
        - Parse `cwd` from first line if file is new. Emit `session:new:<cwd>`
          with { session_id (from file stem), preview, jsonl_created_at_ms }.
        - Parse subsequent lines: if type=="custom-title" OR type=="summary",
          re-scan the full file (cheap: SCAN_LINES_FOR_CWD in sessions.rs already
          does this) and emit `session:meta:<cwd>` with full SessionMeta.
    - Don't emit for every line — emit max once per file per debounce window,
      with the LATEST meta.
  REFACTOR sessions.rs: extract `scan_session_file` into a pub fn so the watcher
    can reuse it.
  REGISTER: capabilities must allow `session:new:*` and `session:meta:*` event listens.
  BOOT: in lib.rs run(), after Builder::default(), before .invoke_handler: spawn
    a tokio task that installs the watcher using app.handle() for emit.

Task 7: Frontend session-watcher context
  CREATE: src/context/session-watcher.tsx
    - On provider mount: listen<SessionNewPayload>('session:new:*') and
      listen<SessionMeta>('session:meta:*'). Note: Tauri v2 doesn't allow glob
      listens — we need listen per active project OR a single global channel
      `session:new` / `session:meta` with project_path in the payload. CHOOSE
      the global-channel approach.
  LOGIC on session:new (FIFO queue with sanity guard — see "Known gotchas"):
    - Collect pending tabs: sessionId === null AND projectPath === payload.project_path,
      sorted by spawnedAt ascending.
    - Pop the OLDEST. Sanity guard: skip if (payload.jsonl_created_at_ms + 30_000 < oldest.spawnedAt).
    - Promote: set tab.sessionId = payload.session_id, if label was "New session"
      replace with payload.preview (truncated). Save lastSessionId for that project.
    - If no pending tab found: ignore (session created by another tool or already correlated).
  LOGIC on session:meta:
    - If any tab has sessionId === payload.id, update tab.label = displayLabel(payload).
    - Bump sessionsRefresh signal so SessionsList re-renders.
  WIRING: add <SessionWatcherProvider> inside <TerminalProvider> in App.tsx.

Task 8: Terminal store — add spawnedAt
  MODIFY: src/context/terminal.tsx
    - TerminalTab: add spawnedAt: number.
    - openTab: spawnedAt = Date.now() at the top of the function.
  (No backend change; correlation happens in session-watcher.tsx.)

Task 9: CLAUDE.md + PROJECT.md updates
  MODIFY CLAUDE.md:
    - Add to Module boundaries: src-tauri/src/fs.rs, src-tauri/src/session_watcher.rs, src/context/sidebar.tsx, src/context/session-watcher.tsx, src/components/file-tree/*, src/components/sidebar-panel.tsx.
    - Update "What this project is" paragraph to mention the file tree.
  MODIFY PROJECT.md:
    - Sprint 03 status: done (when closed).
    - Add to completed phases list.
  CREATE docs/sprint-03-file-tree-and-watcher.md: planning doc (mirrors the PRP).
  CREATE docs/sprint-03-results.md: at close (LOC, surprises, follow-ups → PRP 005).

Task 10: Validation + regression
  RUN: bun run typecheck, cargo check, cargo clippy -- -D warnings.
  MANUAL: follow the Validation Loop below step-by-step.
```

### Pseudocode (critical details)

```rust
// src-tauri/src/fs.rs — gitignore-aware listing
pub fn list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(&path)
        .max_depth(Some(1))
        .hidden(true)         // skip .dotfiles
        .git_ignore(true)
        .git_global(true)
        .parents(false)
        .build();
    for entry in walker.flatten() {
        // WalkBuilder includes the root itself at depth 0 — skip it.
        if entry.path() == std::path::Path::new(&path) { continue; }
        let p = entry.path().to_string_lossy().into_owned();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = entry.metadata().ok().and_then(|m| if is_dir { None } else { Some(m.len()) });
        out.push(FsEntry { path: p, name, is_dir, size });
    }
    // Sort: dirs first, then alpha (case-insensitive).
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}
```

```rust
// src-tauri/src/session_watcher.rs — the correlation skeleton
pub fn install(app: tauri::AppHandle) -> anyhow::Result<()> {
    let root = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home"))?.join(".claude/projects");
    std::fs::create_dir_all(&root)?; // tolerate missing

    let offsets: Arc<Mutex<HashMap<PathBuf, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let (tx, rx) = std::sync::mpsc::channel();
    let mut debouncer = new_debouncer(Duration::from_millis(200), None, tx)?;
    debouncer.watcher().watch(&root, RecursiveMode::Recursive)?;

    // spawn_blocking because notify uses blocking channels.
    std::thread::spawn(move || {
        for result in rx {
            let Ok(events) = result else { continue };
            for ev in events {
                for path in &ev.paths {
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
                    handle_jsonl_change(&app, path, &offsets);
                }
            }
        }
        // keep debouncer alive in this thread
        let _hold = debouncer;
    });
    Ok(())
}

fn handle_jsonl_change(app: &tauri::AppHandle, path: &Path, offsets: &Arc<Mutex<HashMap<PathBuf, u64>>>) {
    // 1. Read from offset to EOF. If file is new, offset = 0.
    // 2. Track if this is the first lines of a new file (emit session:new).
    // 3. Re-scan full file for custom-title/summary (cheap) → emit session:meta with SessionMeta.
    // 4. Advance offset.
    let session_id = path.file_stem().and_then(|s| s.to_str()).map(str::to_string);
    let Some(session_id) = session_id else { return };

    let cwd = sessions::read_cwd(path); // requires making read_cwd pub(crate) in sessions.rs
    let Some(cwd) = cwd else { return };

    let mut map = offsets.lock().unwrap();
    let prev_offset = map.get(path).copied().unwrap_or(0);
    let Ok(meta) = std::fs::metadata(path) else { return };
    let new_offset = meta.len();
    map.insert(path.to_path_buf(), new_offset);
    drop(map);

    let is_new_file = prev_offset == 0 && new_offset > 0;
    let meta_struct = sessions::scan_session_file_pub(path);

    if is_new_file {
        let _ = app.emit("session:new", &SessionNewPayload {
            project_path: cwd.clone(),
            session_id: session_id.clone(),
            jsonl_created_at_ms: meta.created().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            preview: meta_struct.first_preview.clone(),
        });
    }
    // Always emit a meta refresh so /rename and /summary propagate.
    let _ = app.emit("session:meta", &SessionMeta {
        id: session_id,
        timestamp: meta_struct.first_timestamp,
        first_message_preview: meta_struct.first_preview,
        custom_title: meta_struct.custom_title,
        summary: meta_struct.summary,
        project_path: cwd,
    });
}
```

```tsx
// src/context/session-watcher.tsx — correlation
createEffect(() => {
  const unlistens = [
    listen<SessionNewPayload>("session:new", (e) => {
      const { project_path, session_id, jsonl_created_at_ms, preview } = e.payload;
      // Oldest "new" tab for this project, spawned BEFORE the JSONL was written.
      const candidate = term.store.tabs
        .filter((t) => t.projectPath === project_path
                    && t.sessionId === null
                    && t.spawnedAt <= jsonl_created_at_ms)
        .sort((a, b) => a.spawnedAt - b.spawnedAt)[0];
      if (!candidate) return;
      term.promoteTab(candidate.id, session_id, preview);  // new API
      setLastSessionId(project_path, session_id);
    }),
    listen<SessionMeta>("session:meta", (e) => {
      const meta = e.payload;
      const tab = term.store.tabs.find((t) => t.sessionId === meta.id);
      if (tab) term.setTabLabel(tab.id, displayLabel(meta));      // new API
      sessionsRefresh.bump(meta.project_path);                    // refresh signal
    }),
  ];
  onCleanup(() => unlistens.forEach((p) => p.then((fn) => fn())));
});
```

### Integration points
```yaml
TAURI_CAPABILITIES (src-tauri/capabilities/default.json):
  - "core:event:allow-listen" for events matching "fs:event:*", "session:new", "session:meta"
  - invoke permissions for: list_dir, watch_project, unwatch_project
  - if using tauri-plugin-shell for `open -R`: allow cmd "open" with args validator

TAURI_REGISTRATION (src-tauri/src/lib.rs):
  - invoke_handler: ..., fs::list_dir, fs::watch_project, fs::unwatch_project
  - manage(fs::FsWatcherState::default())
  - after Builder is built but before .run(): tauri::async_runtime::spawn(async move { session_watcher::install(handle).await })

CONTEXT_WIRING (src/App.tsx):
  - App root: <ProjectsProvider><TerminalProvider><SidebarProvider><SessionWatcherProvider><Shell/></...></...>
```

---

## Validation Loop

### Level 1: Syntax & style (fast feedback)
```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
cd src-tauri && cargo fmt --check
```

### Level 2: Unit tests
- No Vitest/cargo-test infra added in this sprint. Manual verification only.
- If time permits, a smoke test for `fs::list_dir` in `src-tauri/src/fs.rs` using `#[cfg(test)]` + `tempfile` crate.

### Level 3: Integration / manual
```bash
bun tauri dev
```

**Sidebar tabs + collapse:**
1. Open a project. Sidebar default: Sessions tab active.
2. Click Files → tree loads, root children visible.
3. Switch project. Re-enter first project → Files is still active (per-project memory).
4. Press Cmd+B → sidebar collapses to 12px rail.
5. Click rail → expands. Cmd+B again → collapses. Close/reopen app → still collapsed.

**File tree:**
6. Expand `src/` → children load.
7. `touch src/hello.txt` in a real terminal → appears within 300ms.
8. `rm src/hello.txt` → disappears within 300ms.
9. `node_modules/` is not visible (gitignore'd).
10. `.git/` is not visible (hidden).
11. Right-click a file → menu with "Copy path" + "Reveal in Finder".
12. Expand a directory with 1000+ files → UI stays responsive (<300ms).

**JSONL watcher:**
13. Open a tab (resume or new), type `/rename My Session`, press Enter → tab label updates within 500ms; sessions-list preview updates too.
14. Click "+ New session" → new tab labeled "New session". Type `hello` + Enter → label updates to the first-message preview within 2-5s; sidebar shows it as open.
15. Close the app, reopen → auto-resume works for the promoted session.
16. Manually delete the JSONL for a "new" tab before Claude writes it (rare) → tab stays `sessionId: null`, no crash.

**Regression (Sprint 02 must still pass):**
17. Multi-tab + tab strip + switching + close + reopen — all from PRP 003 steps 1-11.

Expected:
- No red in Tauri devtools console.
- Rust logs show watcher debounces correctly (no event floods during `bun install`).
- Typecheck + clippy clean.

---

## Final Checklist

- [ ] `bun run typecheck` clean
- [ ] `cargo check` + `cargo clippy -- -D warnings` clean
- [ ] 17 manual integration steps pass
- [ ] CLAUDE.md module list updated
- [ ] PROJECT.md Sprint 03 marked done when closed
- [ ] `docs/sprint-03-file-tree-and-watcher.md` + `docs/sprint-03-results.md` created
- [ ] capabilities/default.json: new events + commands listed
- [ ] No regression in Sprint 02 multi-tab flow
- [ ] New Cargo deps (`notify`, `notify-debouncer-full`, `ignore`) committed to `Cargo.lock`

---

## Anti-Patterns to Avoid

- ❌ **Raw `notify::Watcher` without a debouncer** → floods of events on macOS; flaky.
- ❌ **Parsing `.gitignore` by hand** → use the `ignore` crate; nested gitignores and globals work for free.
- ❌ **Re-fetching the whole project tree** on any fs event → use `applyFsEvent` patching.
- ❌ **Re-rendering the tree root** on every event → use path-keyed store mutations so only affected rows re-render.
- ❌ **Parsing PTY output** to detect `/rename` → violates CLAUDE.md rule #2. Watch the JSONL.
- ❌ **Emitting a frontend event per JSONL line** → coalesce per-file per-debounce-tick.
- ❌ **Correlating "new" tabs by filesystem-order alone** → always include `spawnedAt <= jsonl_created_at_ms` to avoid claiming pre-existing sessions.
- ❌ **Global watch across all `~/.claude/projects/` from the frontend** → do it once in Rust at app boot; don't spin up a watcher per project.
- ❌ **Persisting collapsed state per-project** → global is the expected UX (matches Warp, VS Code).
- ❌ **Opening files on single-click** → nothing in Sprint 03 to "open" them into; reserve for Sprint 04 diff viewer.
- ❌ **Using `display: none` on the sidebar when collapsed** → breaks width transition; use `width: 12px` + conditional content instead.

---

## Notes

**Decisions made during generation:**

- **Sidebar tabs live inside the existing 280px aside, below the project title.** No new column. Panel collapses to 12px (rail with chevron), not 0 — a visible expand affordance is important UX.
- **Collapsed state is global, active-tab is per-project.** Warp and VS Code both do it this way. Global collapsed matches "mode-of-work" (focus vs. browse); per-project tab matches "what was I doing in this repo".
- **File-click is select-only in Sprint 03.** No open/diff/preview. Documented so the implementer doesn't invent something.
- **JSONL watcher is a single global watcher in Rust**, installed at app boot. Frontend subscribes to `session:new` and `session:meta` (flat channels, project_path in payload) — not per-project glob listens, which Tauri v2 doesn't support cleanly.
- **`spawnedAt` added to TerminalTab** to make the new-tab-correlation heuristic robust.
- **`read_cwd` and `scan_session_file` in sessions.rs must become `pub(crate)`** so the watcher can reuse them without duplicating JSONL parsing.

**Deferred to PRP 005 (activity panel):**
- "Which files is Claude touching right now?" — requires parsing `tool_use` blocks (Edit/Write) from JSONL lines as they append. Natural next step once the tailer exists. Different UI surface (probably a collapsible strip below the terminal, or a third sidebar tab).

**Deferred to PRP 006+ (Claude Code Channels integration):**
- [Claude Code Channels](https://code.claude.com/docs/en/channels-reference) (research preview, requires CC v2.1.80+) let an MCP server push events INTO Claude and relay permission prompts. Investigated during PRP 004 drafting and confirmed it's direction-inverted from what we need for the JSONL watcher (we want to CONSUME events FROM Claude, channels let us PUSH events TO Claude). But the `claude/channel/permission` relay is interesting for a future sprint: we could show Claude's "allow Bash/Write?" prompts as a native sidebar panel in cc-ui, bypassing the TUI dialog. Also opens the door to cc-ui itself exposing a channel (e.g., "send this diff to the active Claude tab" from the file tree).

**Deferred to Sprint 04:**
- File preview / diff viewer (`@pierre/diffs`).
- Open-in-editor on double-click.
- Toggle to show hidden files / gitignored entries.

**Confidence for one-pass success: 7.5/10** (bumped from 7 after resolving dep versions, opener API, and locking FIFO correlation strategy). Remaining risk:
- `notify-debouncer-full` 0.6 API changed from earlier versions; first use in this repo — small integration risk.
- FSEvents on macOS has documented edge cases (Time Machine, network volumes, symlinks). Mitigation: debounce 150ms, ignore events outside project root.
- FIFO tab correlation is a documented compromise (see known edge case). Not a crash risk; only a UX-rare misattribution.
- The UI-only portions (sidebar tabs, collapse, tree rendering) are fully mechanical and low risk.
