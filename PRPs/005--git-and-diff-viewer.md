# PRP 005: Git status + Diff viewer

> **Version:** 1.0
> **Created:** 2026-04-19
> **Status:** Ready
> **Phase:** Sprint 04 (Git + Diff viewer)

---

## Goal

When the user opens a project, each file in the file-tree shows an A/M/D/? badge reflecting its `git status` against the workdir, and the titlebar shows a running `+N −M` indicator. Double-clicking a changed file (or clicking the titlebar badge) opens a resizable right-side panel next to the terminal that renders the file's diff via `@pierre/diffs`. The panel lives alongside the terminal (not inside it, not a new tab) so Claude-in-PTY stays visible while the user reviews changes. Closing the panel returns the terminal to full width. Status and badge stay in sync with filesystem events: whenever `fs.rs` emits a debounced batch for the project, `git_status` and `git_summary` are re-queried and the UI patches.

## Why

- **Closes the "Claude edited X" loop.** Sprint 03 gave us a file tree — you can *see* which files exist but not which ones changed, and you have to leave klaudio-panels to review the diff. Without this, the file tree is decorative.
- **Converts klaudio-panels from "terminal shell" into "IDE-lite for Claude."** The diff viewer is the single biggest feature that justifies running `claude` inside klaudio-panels instead of iTerm. Everything else (tabs, session list, file tree) is incremental; this is a *visible* differentiator.
- **Unblocks future review flows.** Once the diff rendering and git layer are in place, staged-vs-workdir toggles, accept/reject hunks, and inline comments (future sprints) become additive, not structural.
- **Empirical validation of rule #7.** CLAUDE.md says "filesystem + git = source of truth." Sprint 03 tested filesystem; Sprint 04 tests git. If we need to revisit that decision, this is when we'll know.

## What

- **Rust side**: `git.rs` with three Tauri commands backed by `git2` (libgit2): `git_status`, `git_summary`, `git_diff_file`. All three operate on a project path and return fast, non-blocking snapshots. No background watchers on our side — we piggyback on the existing `fs::watch_project` debounced stream.
- **Frontend side**: a `GitProvider` context keyed per-project (status list + summary cache + in-flight diff request), a badge column in the file tree, a `+N −M` pill in the titlebar, a `<DiffPanel>` component that mounts `@pierre/diffs` `FileDiff`, and a resizable split between `<TerminalSection>` and `<DiffPanel>`.
- **Refresh**: the `GitProvider` subscribes to `fs:event:<projectPath>` (already emitted by `fs.rs`). Each debounced batch coalesces into a single status refetch (300ms debounce on top of the 150ms fs debounce). First subscription also triggers an initial fetch.
- **Read-only in v1.** No commit, no stage/unstage, no accept/reject. You see the diff. Writing to the repo is deferred to a later sprint.
- **Workdir-vs-HEAD only in v1.** No separate staged view, no commit-to-commit diffing. Most Claude work lives in the workdir; staged diffs are a follow-up PRP.

### Success Criteria

- [ ] Opening a project inside klaudio-panels populates A/M/D/? badges on each changed file in the tree within 500ms of the tree loading. Unchanged files have no badge.
- [ ] Titlebar pill shows `+N −M` where N and M are the total workdir adds/dels across all non-binary tracked files plus untracked files' line counts. Pill is hidden when both are zero.
- [ ] Editing a file (via Claude or externally) updates the badge + pill within one debounce window (~450ms) without any manual refresh.
- [ ] Double-clicking a changed file in the tree opens the diff panel and renders the diff. The terminal stays visible on the left and remains interactive.
- [ ] Dragging the splitter between terminal and diff panel resizes both smoothly; release persists width in `localStorage["diffPanelWidth:<projectPath>"]`.
- [ ] Clicking the titlebar pill toggles the diff panel (opens to the first changed file if there's no current selection; closes if already open).
- [ ] Cmd+Shift+D toggles the diff panel from anywhere.
- [ ] Binary files show a "Binary file" placeholder in the panel instead of attempting to render. Gitignored files never show badges.
- [ ] Deleted files render with their old contents on the left, empty on the right. Untracked files render empty on the left, current contents on the right.
- [ ] Diff panel syntax-highlights via Shiki (built into `@pierre/diffs`) without us having to preload grammars manually.
- [ ] Closing the diff panel returns the terminal to full width and does not leak the `FileDiff` instance (verify with Chrome DevTools memory snapshot — no retained `FileDiff` after close).
- [ ] `cargo clippy -- -D warnings` clean; `bun run typecheck` clean.

---

## All Needed Context

### Project-level references (always relevant)
```yaml
- file: PROJECT.md
  why: Phase roadmap — Sprint 04 slot
- file: CLAUDE.md
  why: Non-negotiables — rule #7 (fs+git = source of truth), rule #8 (@pierre/diffs as engine)
```

### Feature-specific documentation & references
```yaml
# @pierre/diffs API surface (local inspection at /tmp/pierre-diffs/package/)
- file: /tmp/pierre-diffs/package/dist/components/FileDiff.d.ts
  why: FileDiff class signature — constructor(options), render({ oldFile, newFile, fileContainer }), cleanUp(), rerender(), setThemeType()
  critical: Not a React component. Instantiate once per mount, call .render(...) with FileContents { name, contents }, call .cleanUp() on unmount. oldFile=undefined for untracked, newFile=undefined for deleted.

- file: /tmp/pierre-diffs/package/dist/types.d.ts
  why: FileContents = { name: string; contents: string; language?: SupportedLanguages }. Extension-based language inference is built-in.

- url: https://diffs.com
  why: Official docs + live examples for @pierre/diffs
  critical: The `react` subexport wraps the same classes. We use the vanilla import.

# git2 / libgit2
- url: https://docs.rs/git2/0.20
  why: Repository::open, Repository::statuses, Repository::diff_index_to_workdir, Repository::diff_tree_to_workdir_with_index
  critical: DiffOptions::include_untracked(true) + recurse_untracked_dirs(true) is required to see new files. Status::IGNORED is filtered by default but always double-check StatusOptions::include_ignored(false).

- url: https://libgit2.org/libgit2/#HEAD/group/status
  why: GIT_STATUS_WT_NEW / _MODIFIED / _DELETED / _RENAMED / INDEX_* bitmask semantics
  critical: A file can be both INDEX_MODIFIED + WT_MODIFIED (staged + further edits). In v1 we report the combined status as "M" — we do not distinguish index-vs-workdir states.

# Existing code to extend
- file: src-tauri/src/fs.rs
  why: emits `fs:event:<projectPath>` on debounced batches — we subscribe to refetch status
  critical: Debounce is 150ms. Gitignored paths already filtered. Add our own 300ms coalesce on the frontend side to avoid churning git2 during large saves.

- file: src/components/file-tree/tree-node.tsx
  why: Where to render the A/M/D/? badge column. Current node already has path + name; we add a slot for a trailing badge.

- file: src/components/titlebar.tsx
  why: Where to mount the +N −M pill, to the right of the sidebar toggle.

- file: src/App.tsx
  why: Layout shell. Currently `<main flex-1 flex>` with ProjectsSidebar + SidebarPanel + <section terminal>. Needs a `<SplitTerminalDiff>` wrapper around the terminal section and diff panel.
```

### Current repo state
```bash
eza --tree --level=2 --git-ignore src/ src-tauri/src/
```

### Desired changes (files to add/modify)
```bash
src-tauri/src/
├── git.rs                     # NEW: git_status / git_summary / git_diff_file + types
└── lib.rs                     # MODIFY: register commands, module

src-tauri/
├── Cargo.toml                 # MODIFY: add git2 = "0.20"
└── capabilities/default.json  # unchanged — git commands need no extra permissions

src/
├── context/
│   └── git.tsx                # NEW: per-project status cache + fs event subscription
├── components/
│   ├── diff-panel/
│   │   ├── diff-panel.tsx     # NEW: right-side panel, mounts @pierre/diffs FileDiff
│   │   ├── diff-panel-header.tsx # NEW: file picker dropdown + close button
│   │   └── split-pane.tsx     # NEW: resizable divider between terminal + diff panel
│   ├── file-tree/
│   │   └── tree-node.tsx      # MODIFY: render badge (A/M/D/?) if present
│   ├── titlebar.tsx           # MODIFY: mount GitSummaryPill
│   └── git-summary-pill.tsx   # NEW: +N −M indicator, click toggles diff panel
├── lib/
│   ├── diff-panel-prefs.ts    # NEW: localStorage helpers for panel width + open/closed state
│   └── git-status.ts          # NEW: shared FileStatus type + color map
└── App.tsx                    # MODIFY: wire GitProvider, SplitPane, global Cmd+Shift+D

package.json                   # MODIFY: add @pierre/diffs "^1.1.16"
```

### Known gotchas & project rules
```
CRITICAL — from CLAUDE.md:
- Rule #7: filesystem + git = source of truth. No custom index. Do not cache status
  longer than one fs event cycle without invalidating on fs:event:<projectPath>.
- Rule #8: diff engine is @pierre/diffs. Do NOT introduce diff2html, jsdiff's
  renderer, or a custom diff UI. We can inspect but not replace.
- Rule #11: file-tree watcher is per-project, LRU cap 3. We reuse its events —
  DO NOT add a second watcher for git status.
- Rule #12: custom 40px titlebar with 72px macOS traffic-lights spacer. Any new
  item in the titlebar must not break data-tauri-drag-region on the empty spans.

LIBRARY QUIRKS:
- git2 (0.20): Repository::open is cheap per call; cache only within a command
  invocation. Do NOT hold a Repository across .await in Tauri handlers — it is
  !Send for some state. Use spawn_blocking or keep the handler sync.
- git2 status: StatusOptions::include_untracked(true), recurse_untracked_dirs(true),
  include_ignored(false). Without recurse, new files in new directories show up
  as the directory itself instead of as individual files.
- git2 diff: DiffOptions::context_lines(3) is the default but set explicitly.
  Patch::from_diff + Patch::to_buf gives unified text; we skip that and pass
  old/new blobs directly to @pierre/diffs, which does its own diffing via the
  `diff` JS lib internally.
- git2 blobs: For the "old" side, read from `repo.head()?.peel_to_tree()?.get_path(rel)?.to_object()?.as_blob()`.
  If HEAD doesn't exist (fresh repo), treat as no HEAD and render everything as
  untracked.
- @pierre/diffs FileDiff: new FileDiff(options); diff.render({oldFile, newFile, fileContainer})
  where fileContainer is a <div> we own. diff.cleanUp() on unmount. diff.rerender()
  only after setThemeType or setOptions. For a different file, call render() again
  with new oldFile/newFile.
- @pierre/diffs loads Shiki grammars lazily on first render. First render of a
  large file may block ~100-200ms. Render inside requestAnimationFrame to avoid
  jank during the panel open animation.
- @pierre/diffs expects FileContents { name, contents }. name is used for language
  inference by extension. Pass the relative path (or just basename — we use the
  basename to keep the header clean).
- @pierre/diffs NEEDS its CSS. Import "@pierre/diffs/style.css" once at app boot
  (or just reference the dist/style.js which registers a shadow DOM style). Check
  the package's README for the exact import path if renders show as unstyled text.
- Binary detection: git2's DiffDelta::is_binary flag OR probe the first N KB for
  null bytes. `@pierre/diffs` does not gracefully fail on binaries — we must
  detect and render our own placeholder.
- SolidJS reactivity: `<For>` the status array, not `.map()`. status is keyed by
  path, so use getNodeKey / keyed prop to avoid full re-renders on every fs event.
- Resize splitter: use pointer events (pointerdown/move/up) + setPointerCapture,
  not mouse events (don't lose drag when cursor leaves the divider).

SPECIFIC TO THIS SPRINT:
- Don't attempt to "detect rename" inside git2 — libgit2's rename detection is
  expensive and non-deterministic. Show renames as a "D" on the old path and an
  "A" on the new one. We can revisit in a later sprint if it becomes a UX issue.
- A git status call on a very large repo (chromium-scale) can take >1s. In
  practice our target projects are 100-10k files, <50ms. If someone opens
  chromium, we'll feel it — add a visible loading state on the badge column
  rather than silently blocking.
- Don't re-fetch the diff on every fs event for the currently open file. Debounce
  the diff fetch separately (300ms trailing edge) and keep the previous diff
  visible until the new one renders — prevents flicker during rapid saves.
- The titlebar pill is a drag-region conflict if we make the whole header
  draggable and then put buttons inside. Follow the existing titlebar.tsx
  pattern: explicit data-tauri-drag-region on empty flex spacers only.
```

---

## Implementation Blueprint

### Data models / types

```rust
// src-tauri/src/git.rs
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum FileStatusKind { Added, Modified, Deleted, Renamed, Untracked, Conflicted }

#[derive(Debug, Serialize, Clone)]
pub struct FileStatus {
    pub path: String,        // repo-relative, forward-slash
    pub kind: FileStatusKind,
    pub staged: bool,        // true if ANY part is in the index
    pub adds: usize,         // lines added in workdir vs index (or HEAD for untracked)
    pub dels: usize,         // lines deleted similarly
    pub is_binary: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitSummary {
    pub file_count: usize,
    pub adds: usize,
    pub dels: usize,
    pub branch: Option<String>,  // "main", or None if detached / no HEAD
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffPayload {
    pub path: String,
    pub old_contents: Option<String>, // None if untracked
    pub new_contents: Option<String>, // None if deleted
    pub is_binary: bool,
    pub too_large: bool,              // true if >512 KB either side — we skip rendering
}
```

```typescript
// src/lib/git-status.ts
export type FileStatusKind = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export type FileStatus = {
  path: string;
  kind: FileStatusKind;
  staged: boolean;
  adds: number;
  dels: number;
  is_binary: boolean;
};

export type GitSummary = {
  file_count: number;
  adds: number;
  dels: number;
  branch: string | null;
};

export type DiffPayload = {
  path: string;
  old_contents: string | null;
  new_contents: string | null;
  is_binary: boolean;
  too_large: boolean;
};

export const BADGE_COLOR: Record<FileStatusKind, string> = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-rose-400",
  renamed: "text-violet-400",
  untracked: "text-sky-400",
  conflicted: "text-red-500",
};

export const BADGE_LETTER: Record<FileStatusKind, string> = {
  added: "A", modified: "M", deleted: "D",
  renamed: "R", untracked: "?", conflicted: "U",
};
```

### Tasks (in execution order)

```yaml
Task 1: Add git2 dep + scaffold Rust module
  - MODIFY: src-tauri/Cargo.toml (add git2 = "0.20")
  - CREATE: src-tauri/src/git.rs (pub fn git_status, git_summary, git_diff_file + types)
  - MODIFY: src-tauri/src/lib.rs (pub mod git; register in invoke_handler)
  - VALIDATE: cd src-tauri && cargo check

Task 2: Implement git_status
  - Open repo at project_path (bail to empty Vec if not a repo)
  - StatusOptions: include_untracked + recurse_untracked_dirs, include_ignored=false
  - Iterate statuses, build FileStatus rows
  - For adds/dels per file: use repo.diff_index_to_workdir() + DiffStats per delta.
    Untracked files: count lines in the workdir file vs empty.
  - Detect binary via DiffDelta.is_binary OR Blob.is_binary on the HEAD blob.

Task 3: Implement git_summary
  - Sum adds/dels from git_status (or reuse its internals)
  - branch: repo.head().ok().and_then(|h| h.shorthand().map(String::from))
  - Non-fatal if HEAD missing (fresh repo)

Task 4: Implement git_diff_file
  - For modified: blob at HEAD:<path> → old_contents; workdir file → new_contents
  - For untracked: old_contents = None, new_contents = fs::read_to_string
  - For deleted: old_contents = Some(HEAD blob), new_contents = None
  - Binary short-circuit: return is_binary=true, no contents
  - Too-large guard: if either side > 512 KiB, return too_large=true, no contents

Task 5: Install @pierre/diffs + import CSS once at app boot
  - bun add @pierre/diffs@^1.1.16
  - In src/index.tsx or src/index.css, ensure the diffs stylesheet is applied
    (check README: it may auto-register styles on first render; if not, import
    "@pierre/diffs/dist/style.js" for its side-effect)

Task 6: Create GitProvider context
  - CREATE: src/context/git.tsx
  - Store: Map<projectPath, { status: FileStatus[]; summary: GitSummary; lastFetch: number; loading: boolean }>
  - Method: ensureFor(projectPath) — first call triggers fetch + subscribes to fs:event
  - Debounce refetch 300ms trailing on fs events
  - Method: fetchDiff(projectPath, path) — returns Promise<DiffPayload>, no cache
    (or tiny cache keyed on path+lastFetch)

Task 7: Wire badges into file tree
  - MODIFY: src/components/file-tree/tree-node.tsx
  - Pull status from useGit(projectPath) as Accessor<Map<path, FileStatusKind>>
  - Render a 14px badge after the filename when path matches
  - For directories: show a dot if ANY descendant is changed (defer to Task 7b)

Task 7b (optional, if time permits): Directory rollup badges
  - Precompute a dir→changedDescendantCount map from status list
  - Render a smaller dot next to directory names with count>0

Task 8: GitSummaryPill in titlebar
  - CREATE: src/components/git-summary-pill.tsx
  - Reads useGit().summary(activeProjectPath)
  - Shows "+N −M" in small monospace with colored numbers
  - Click → diffPanel.toggle()
  - MODIFY: src/components/titlebar.tsx (mount after sidebar toggle, before drag filler)
  - Titlebar receives activeProjectPath + hooks from parent

Task 9: DiffPanel context + state
  - CREATE: src/context/diff-panel.tsx
  - Signals: openFile (string | null), width (number, default 50% of non-sidebar area)
  - Methods: open(path), close(), setWidth(n), toggle(), cycleFile() (optional)
  - Persist: localStorage["diffPanelWidth:<projectPath>"], "diffPanelOpen"
  - Global Cmd+Shift+D keybind in App.tsx

Task 10: DiffPanel component
  - CREATE: src/components/diff-panel/diff-panel.tsx
  - onMount: create <div ref={container}>; const fd = new FileDiff({ themeType: "dark" })
  - createEffect on openFile: fetch diff; fd.render({ oldFile, newFile, fileContainer: container })
    Handle binary / too_large / deleted / untracked branches.
  - onCleanup: fd.cleanUp()
  - Header component: filename + close button + (optional) file-switcher dropdown

Task 11: SplitPane divider
  - CREATE: src/components/diff-panel/split-pane.tsx
  - Horizontal resize between two children. Drag handle = 4px, cursor ew-resize
  - Uses pointer events + setPointerCapture for correct behavior when leaving divider
  - Constrains to [300px, parentWidth - 360px]

Task 12: Wire everything into App.tsx
  - Provider order: ProjectsProvider → SidebarProvider → GitProvider → DiffPanelProvider → TerminalProvider → SessionWatcherProvider
  - Layout: <main><ProjectsSidebar/><Show when={activeProject}><SidebarPanel/></Show>
           <SplitPane><TerminalSection/><Show when={diffPanel.isOpen}><DiffPanel/></Show></SplitPane></main>
  - Global Cmd+Shift+D listener

Task 13: Validation pass
  - typecheck, cargo check, cargo clippy
  - Manual QA (see Validation Loop)
```

### Pseudocode (Rust side, the load-bearing parts)

```rust
// src-tauri/src/git.rs
use git2::{DiffOptions, Repository, Status, StatusOptions};

#[tauri::command]
pub fn git_status(project_path: String) -> Result<Vec<FileStatus>, String> {
    let repo = match Repository::open(&project_path) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),  // not a repo — no badges, no error
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    // Build a per-path diff-stats map in one diff pass
    let stats_by_path = compute_workdir_stats(&repo)?;  // HashMap<String, (adds, dels, is_binary)>

    let mut out = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or_default().to_string();
        let flags = entry.status();

        let kind = classify(flags);
        if matches!(kind, FileStatusKind::Ignored) { continue; }

        let staged = flags.intersects(
            Status::INDEX_NEW | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        );

        let (adds, dels, is_binary) = stats_by_path
            .get(&path)
            .copied()
            .unwrap_or((0, 0, false));

        out.push(FileStatus { path, kind, staged, adds, dels, is_binary });
    }
    Ok(out)
}

fn compute_workdir_stats(repo: &Repository) -> Result<HashMap<String, (usize, usize, bool)>, String> {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.to_string())?;

    let mut out = HashMap::new();
    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .and_then(|p| p.to_str())
                .map(String::from)
                .unwrap_or_default();
            out.entry(path).or_insert((0, 0, delta.new_file().is_binary() || delta.old_file().is_binary()));
            true
        },
        None, None,
        Some(&mut |delta, _hunk, line| {
            let path = delta.new_file().path().and_then(|p| p.to_str()).unwrap_or_default();
            if let Some(entry) = out.get_mut(path) {
                match line.origin() {
                    '+' => entry.0 += 1,
                    '-' => entry.1 += 1,
                    _ => {}
                }
            }
            true
        }),
    ).map_err(|e| e.to_string())?;
    Ok(out)
}
```

```rust
#[tauri::command]
pub fn git_diff_file(project_path: String, rel_path: String) -> Result<DiffPayload, String> {
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let path = std::path::Path::new(&rel_path);
    let full = std::path::Path::new(&project_path).join(path);

    // Read workdir side (or None if deleted)
    let new_contents = match std::fs::read(&full) {
        Ok(bytes) => {
            if bytes.len() > 512 * 1024 {
                return Ok(DiffPayload { path: rel_path, old_contents: None, new_contents: None, is_binary: false, too_large: true });
            }
            if is_binary_bytes(&bytes) {
                return Ok(DiffPayload { path: rel_path, old_contents: None, new_contents: None, is_binary: true, too_large: false });
            }
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
        Err(_) => None,
    };

    // Read HEAD side
    let old_contents = repo
        .head().ok()
        .and_then(|h| h.peel_to_tree().ok())
        .and_then(|tree| tree.get_path(path).ok())
        .and_then(|entry| entry.to_object(&repo).ok())
        .and_then(|obj| obj.into_blob().ok())
        .map(|blob| {
            let bytes = blob.content();
            if bytes.len() > 512 * 1024 || is_binary_bytes(bytes) { None }
            else { Some(String::from_utf8_lossy(bytes).into_owned()) }
        })
        .flatten();

    Ok(DiffPayload { path: rel_path, old_contents, new_contents, is_binary: false, too_large: false })
}
```

### Pseudocode (Frontend, the load-bearing parts)

```tsx
// src/context/git.tsx
const [store, setStore] = createStore<Record<string, ProjectGitState>>({});
const timers = new Map<string, number>();
const unlisteners = new Map<string, UnlistenFn>();

async function fetchNow(projectPath: string) {
  setStore(projectPath, "loading", true);
  const [status, summary] = await Promise.all([
    invoke<FileStatus[]>("git_status", { projectPath }),
    invoke<GitSummary>("git_summary", { projectPath }),
  ]);
  setStore(projectPath, produce(s => { s.status = status; s.summary = summary; s.loading = false; s.lastFetch = Date.now(); }));
}

function scheduleRefetch(projectPath: string) {
  const prior = timers.get(projectPath);
  if (prior) clearTimeout(prior);
  timers.set(projectPath, setTimeout(() => fetchNow(projectPath), 300) as unknown as number);
}

async function ensureFor(projectPath: string) {
  if (store[projectPath]) return;
  setStore(projectPath, { status: [], summary: { file_count: 0, adds: 0, dels: 0, branch: null }, loading: true, lastFetch: 0 });
  const un = await listen(`fs:event:${projectPath}`, () => scheduleRefetch(projectPath));
  unlisteners.set(projectPath, un);
  await fetchNow(projectPath);
}

onCleanup(() => {
  for (const [, un] of unlisteners) un();
  for (const [, t] of timers) clearTimeout(t);
});
```

```tsx
// src/components/diff-panel/diff-panel.tsx
import { FileDiff } from "@pierre/diffs";

export function DiffPanel(props: { projectPath: string }) {
  let containerRef!: HTMLDivElement;
  let fd: FileDiff | undefined;
  const git = useGit();
  const dp = useDiffPanel();

  onMount(() => {
    fd = new FileDiff({ themeType: "dark" });
  });

  onCleanup(() => { fd?.cleanUp(); fd = undefined; });

  createEffect(async () => {
    const file = dp.openFile();
    if (!file || !fd) return;
    const payload = await git.fetchDiff(props.projectPath, file);
    if (payload.is_binary) { renderBinaryPlaceholder(containerRef); return; }
    if (payload.too_large) { renderTooLargePlaceholder(containerRef); return; }
    requestAnimationFrame(() => {
      fd!.render({
        oldFile: payload.old_contents != null ? { name: basename(file), contents: payload.old_contents } : undefined,
        newFile: payload.new_contents != null ? { name: basename(file), contents: payload.new_contents } : undefined,
        fileContainer: containerRef,
      });
    });
  });

  return (
    <div class="flex flex-col h-full bg-neutral-950 border-l border-neutral-800">
      <DiffPanelHeader />
      <div ref={containerRef} class="flex-1 overflow-auto" />
    </div>
  );
}
```

### Integration points
```yaml
TAURI_REGISTRATION:
  - file: src-tauri/src/lib.rs
  - add to invoke_handler: git::git_status, git::git_summary, git::git_diff_file

TAURI_CAPABILITIES:
  - none — git2 runs in-process, not a plugin. No capability changes required.

CONTEXT_WIRING:
  - file: src/App.tsx
  - Provider tree updated (see Task 12)
  - Global Cmd+Shift+D keybind attached in the same effect that handles Cmd+B

PACKAGE:
  - package.json add: "@pierre/diffs": "^1.1.16"

LOCALSTORAGE KEYS (add to CLAUDE.md memory conventions):
  - diffPanelOpen                        (global bool, "1" or absent)
  - diffPanelWidth:<projectPath>         (per-project number in pixels)
```

---

## Validation Loop

### Level 1: Syntax & style
```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

### Level 2: Unit tests
Skip for v1. The git2 layer is thin enough that manual QA catches more than unit tests would, and we have no Rust test scaffolding yet. Add `cargo test` harness in a follow-up PRP if we grow this module.

### Level 3: Integration / manual QA

```bash
bun tauri dev
```

QA checklist (run against a project with a non-trivial git history):

1. **Badges appear on changed files.** Modify a tracked file externally (`echo x >> README.md`), open the project, confirm `M` badge (amber) appears on the file.
2. **Untracked files.** Create `touch PRPs/hello.md`, confirm `?` badge (sky) appears within ~500ms of save.
3. **Delete a file.** `rm some-tracked-file.txt`, confirm `D` badge (rose) appears.
4. **Gitignored files are invisible.** Create `touch node_modules/x/fake.ts` (or similar path matching .gitignore). Confirm NO badge.
5. **Titlebar pill.** Make edits that sum to `+12 −3` across 3 files. Confirm pill reads `+12 −3`. Revert all changes, pill disappears.
6. **Live refresh.** With the project open, have Claude (in the PTY) edit a file. Badge appears without manual refresh.
7. **Double-click opens diff panel.** Double-click the modified file. Diff panel opens on the right, terminal stays visible on the left.
8. **Diff renders correctly.** Compare the inline diff to `git diff <file>` output. Adds/dels match.
9. **Untracked diff.** Double-click the untracked `hello.md`. Panel renders empty-left / content-right.
10. **Deleted diff.** Double-click the deleted file. Panel renders content-left / empty-right.
11. **Binary file.** `cp some.png test-binary.png`, double-click. Panel shows "Binary file" placeholder, not gibberish.
12. **Large file guard.** Create a 600 KB text file, double-click. Panel shows "File too large" placeholder.
13. **Splitter drag.** Drag the splitter between terminal and diff panel. Both panes resize live; terminal fits (xterm FitAddon fires). On release, reopening the project restores the saved width.
14. **Cmd+Shift+D toggles panel.** Panel closed → opens to first changed file. Panel open → closes.
15. **Titlebar pill click toggles panel.** Same behavior as Cmd+Shift+D.
16. **Close button.** Click X in the panel header. Panel closes, terminal returns to full width.
17. **No leak on close.** Open DevTools Memory tab, take heap snapshot with panel open, close panel, take second snapshot. No retained `FileDiff` or `Shiki` heap refs bigger than a Shiki highlighter singleton.
18. **No repo case.** Open a directory that isn't a git repo. No badges, no pill, no errors in the Tauri devtools console.
19. **Switch projects.** Open project A (has changes) → project B (clean) → back to A. Badges re-appear for A correctly.
20. **No regression.** Terminal still resumes sessions, fs events still update the file tree, Cmd+B still toggles the sidebar.

Expected:
- All 20 steps pass with no unhandled errors in the Tauri devtools console or Rust log.
- CPU stays idle during pure-read operations (open a large repo, no edits → <1% CPU).

---

## Final Checklist

- [ ] `bun run typecheck` clean
- [ ] `cd src-tauri && cargo check` clean
- [ ] `cd src-tauri && cargo clippy -- -D warnings` clean
- [ ] Manual QA: all 20 steps above pass
- [ ] `CLAUDE.md` updated: new non-negotiable if any emerges (e.g. "diff fetch is always lazy, never eager")
- [ ] `PROJECT.md` updated: Sprint 04 status → "in progress" / "done"
- [ ] `v0.4.0` tagged after merge (annotated)

---

## Anti-Patterns to Avoid

- ❌ Don't spawn a second `notify` watcher for git-state changes. Reuse `fs:event:<projectPath>`.
- ❌ Don't cache git status across fs events without invalidating. Rule #7.
- ❌ Don't render diffs inside a new tab in the tab strip — the terminal must stay visible.
- ❌ Don't hold a `Repository` across an `.await` in a Tauri handler. Keep handlers sync or wrap in `spawn_blocking`.
- ❌ Don't attempt to commit or stage from the diff viewer in v1. Read-only.
- ❌ Don't add a "refresh" button. The refresh loop is fs event → debounce → fetch; manual refresh masks bugs in that loop.
- ❌ Don't preload Shiki grammars at boot. Let `@pierre/diffs` lazy-load them on first render — boot time matters more than first-diff latency.
- ❌ Don't pass unified-diff text to `@pierre/diffs`. It wants `FileContents { name, contents }` for old and new — it diffs internally.
- ❌ Don't use mouse events for the splitter. Use pointer events + `setPointerCapture`.
- ❌ Don't couple the diff panel to a specific project path — persist width per-project but the panel itself is a shell state, not owned by a project.

---

## Notes

- **Deferred**: staged-vs-workdir toggle, commit UI, multi-file side-by-side in the panel, accept/reject hunks, inline comments, rename detection. All additive on top of this PRP.
- **Follow-up PRP 006** candidates (rank when Sprint 04 closes): (a) activity panel from JSONL tool_use stream, (b) diff viewer staged vs workdir toggle + commit box, (c) auto-update + dmg packaging.
- **Confidence: 8/10.** The git2 surface is narrow and well-documented; @pierre/diffs has a small class-based API that fits SolidJS cleanly. Main risk is the splitter + panel mounting interaction with `xterm.js` FitAddon on resize — we already solved a similar resize loop in Sprint 02 for tab-switch refresh, so we can reuse the `term.refresh()` + `fit()` pattern. -1 for CSS-styling of `@pierre/diffs` in a Solid app (the React subexport is the documented path; we're using vanilla and relying on the package's auto-registered styles, which may need a manual `import` of its stylesheet). -1 for large-repo performance unknowns — mitigated by the `too_large` guard and by keeping status calls synchronous on a blocking thread if they turn out slow.
