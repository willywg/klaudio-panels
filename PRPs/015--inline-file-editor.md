# PRP 015: Inline file editor — quick "Edit" from the file tree

> **Version:** 1.1
> **Created:** 2026-04-24
> **Status:** Draft
> **Tracks:** [#34](https://github.com/willywg/klaudio-panels/issues/34)

---

## Goal

Give the user a **simple, fast, in-app way to modify a file** without leaving
klaudio-panels and without depending on an external editor (`nvim`, VS Code,
etc.). Right-clicking a file in the tree exposes a new top-level **"Edit"**
entry that opens a writable tab in the diff panel. The tab is a thin
CodeMirror 6 surface — syntax highlighting, line numbers, dark theme — bound
to the same path the preview tab would have used. `⌘S` writes the buffer
back to disk; the file-tree watcher (already running) picks up the change
automatically and the diff panel's Git-changes tab updates accordingly.

This is **additive** to PRPs 006 (read-only preview) and 007 (PTY-embedded
nvim/helix). Preview stays the default for a left-click / double-click; the
new "Edit" entry is the explicit, opt-in path for "I want to change one line
right now without context-switching."

## Why

- Closes the smallest remaining gap in the file-browsing flow. Today the
  user can **see** any file (preview), can **open it elsewhere** (Open in →
  VS Code/Cursor), or can **edit it through a terminal editor** if `nvim` /
  `helix` is installed. None of those covers the most common case: a quick
  one-line tweak (typo, version bump, copy edit) where launching another app
  or a TUI editor is overkill.
- Aligns with the project vision. klaudio-panels is "a shell around `claude`,
  not a reimplementation of it" — and most edits in this app happen through
  Claude itself in the PTY. A minimal inline editor is the manual escape
  hatch for the small set of edits a user wants to make by hand, not a play
  to become an IDE.
- Bundle-cheap. CodeMirror 6 is ~150 KB gzipped with the languages we need;
  loaded lazily on first edit, identical to how Shiki is already lazy-loaded
  for the preview tab.
- Pure additive: no PTY changes, no Git rework, no new long-running
  processes. The diff panel already has a `kind: "file"` preview tab — the
  new `kind: "edit"` variant lives next to it without disturbing existing
  code.

## What

### Success Criteria

- [ ] Right-clicking a **file** (not a directory) in the file tree shows an
      **"Edit"** entry near the top of the menu, immediately after "Open in
      preview". Disabled with a tooltip when the file is binary or > 1 MiB.
- [ ] Clicking "Edit" opens a new tab in the diff panel labelled
      `<basename>` with a pencil icon. Re-opening the same file focuses the
      existing tab instead of spawning a duplicate.
- [ ] The editor renders the file with line numbers, monospace font, dark
      theme, and CodeMirror language support for the project's common
      languages (TS/JS/TSX/JSON/MD/CSS/HTML/Rust/Python/YAML/SQL). TOML and
      shell scripts fall back to plaintext in v1 (no official CM6 lang
      package; deferred to follow-up via `@codemirror/legacy-modes`).
- [ ] `⌘S` (and `Ctrl+S` on non-macOS) writes the buffer back to disk via a
      new `write_file_bytes` Tauri command. Encoding is UTF-8.
- [ ] Tab title shows a `•` (dirty indicator) when the buffer differs from
      the last saved contents. After a successful save the dot disappears.
- [ ] Closing a dirty tab (X, `⌘W`, right-click → Close tab) shows a small
      confirm prompt: **Save / Discard / Cancel**. Same prompt fires when
      the parent project is closed while any of its edit tabs is dirty;
      Cancel aborts the project close entirely (project stays open with
      its tabs intact).
- [ ] The existing fs watcher (already installed for the file tree) sees
      the write. The diff panel's Git-changes tab and any badges in the
      tree update normally — no special-casing needed.
- [ ] If the file is changed on disk by something else (Claude, git pull,
      another editor) **while** the inline editor is open AND the buffer is
      dirty, the editor shows a non-blocking banner: *"File changed on
      disk. [Reload] [Keep mine]"*. Non-dirty buffers reload silently.
- [ ] Binary files, non-UTF-8 files, and files > 1 MiB never reach the
      editor (the menu entry is disabled, and the Rust command rejects
      oversized writes). Non-UTF-8 is treated identically to "binary" —
      no separate UI branch.
- [ ] `⌘W` closes the active edit tab (existing keybinding — just needs to
      handle the dirty-prompt path).

### Non-goals

- No multi-file find-and-replace, no command palette, no LSP, no autocomplete
  beyond CodeMirror's built-in bracket matching.
- No directory editing. Right-click on a folder still shows only "New File /
  New Folder / Open in / …" — no "Edit" entry.
- No version-control-aware features (no inline diff gutter, no blame). The
  Git-changes tab already covers that surface.
- No persistence of open edit tabs across app restarts. Tabs are ephemeral
  per project lifecycle, same as preview tabs (CLAUDE.md rule on tab state).
- No replacement for PRP 007. Users who prefer `nvim` keep using "Open in →
  Neovim" exactly as today.
- No Linux/Windows polish this sprint. Save and shortcuts must work, but the
  dirty-prompt look-and-feel is tuned for macOS first.

---

## All Needed Context

### Project-level references

```yaml
- file: PROJECT.md
  why: Sprint order + architectural constraints
- file: CLAUDE.md
  why: Filesystem is source of truth (rule #7); localStorage only for app
       settings (rule #6); no PTY parsing (rule #2 — N/A here but reminder
       that this feature reads/writes files directly, no Claude involvement);
       sidebar / diff-panel ownership rules.
- file: PRPs/006--open-in-editor-and-file-preview.md
  why: Read-only preview tab plumbing we extend. Anti-pattern there said
       "Don't try to make the preview editable" — this PRP supersedes that
       restriction with a separate tab kind, not by mutating the preview
       tab.
- file: PRPs/007--pty-embedded-terminal-editor.md
  why: Confirms the explicit non-goal "No built-in editor (Monaco/
       CodeMirror)" was scoped to that PRP. This PRP fills that gap as a
       complementary, lighter path.
```

### Feature-specific references

```yaml
# CodeMirror 6 — chosen over Monaco for bundle size
- url: https://codemirror.net/docs/ref/
  why: Editor APIs for state/transactions, dirty detection via
       update.docChanged.
  critical: CM6 is modular — only import @codemirror/state, view,
            commands, language, and the language packs we actually use.
            Importing @codemirror/basic-setup pulls in tooltips/autocomplete
            we don't want.

- url: https://codemirror.net/docs/ref/#commands.indentWithTab
  why: Tab-key behavior. Default Tab focuses out — we want indentation.
       Wire `keymap.of([indentWithTab])` after the language pack.

- url: https://codemirror.net/examples/styling/
  why: Theme structure. We extend our existing diff-panel CSS variables
       so light/dark stays consistent with Shiki's "github-dark-default".

# Tauri filesystem write
- url: https://v2.tauri.app/develop/calling-rust/
  why: Confirms the standard #[tauri::command] pattern + capabilities.
  critical: write_file_bytes is symmetric to read_file_bytes — REUSE
            resolve_rel from src-tauri/src/file_read.rs to enforce the
            project-root boundary. Do NOT duplicate that logic.

# Existing internal refs
- file: src-tauri/src/file_read.rs
  why: resolve_rel + 1 MiB cap + binary detection. We mirror the structure
       for the new write command.
- file: src-tauri/src/fs.rs
  why: notify-debouncer-full watches the project root. Saves WILL emit
       events through it; we do not need to invent a new event channel.
- file: src/components/diff-panel/file-preview.tsx
  why: Lazy-load + onMount/onCleanup pattern. The new EditorTab follows
       the same shape.
- file: src/context/diff-panel.tsx
  why: PanelTab union; tabKey; openFile / addEditorTab / onBeforeClose.
       New tab kind = "edit".
- file: src/components/file-tree/file-tree.tsx (lines 360–431)
  why: Right-click menuItems(). The new "Edit" entry slots in right after
       "Open in preview" for files.
```

### Known gotchas & project rules

```
CRITICAL — from CLAUDE.md:
- localStorage / signals only. No SQLite for buffer state — buffers are
  ephemeral and live in memory until save or close.
- Files watcher is already installed per project (LRU cap 3, fs.rs). Saves
  go through std::fs::write — they will fire a `fs:event:<projectPath>`
  through the existing pipe and the file-tree store will refresh badges.
  Don't add a second watcher.
- Don't persist the list of open edit tabs (mirrors PTY tab rule #9 — the
  same logic applies: rehydrating N editors with stale buffers is worse than
  a clean start). On project re-open, edit tabs are gone.

LIBRARY QUIRKS:
- CodeMirror 6: imports must be specific. The official lang packs we use
  are `@codemirror/lang-{javascript,json,markdown,css,html,rust,python,yaml,sql}`.
  `@codemirror/lang-javascript` covers JS *and* TS/TSX/JSX via its
  `{ jsx: true, typescript: true }` config — there is NO standalone
  `@codemirror/lang-typescript` package. Pick lang-javascript with the
  flags toggled per file extension. TOML and shell have no official lang
  pack; route them to plaintext for v1.
- CodeMirror 6 + Solid: do NOT mount the EditorView inside a Solid render
  function that re-runs. Mount once in `onMount`, dispose in `onCleanup`.
  Treat the CM EditorView like xterm.js Terminal — single instance per tab,
  manipulated via dispatch().
- Tauri write: std::fs::write replaces the file atomically on POSIX only
  when the file does not need fsync semantics. For our use (single-user,
  small text files, fs watcher reading after write completes) the default
  is fine. Do NOT introduce tempfile + rename indirection — it doubles the
  fs events the watcher emits and produces flicker in the file tree.
- Tauri capabilities: ALL new invoke commands need an entry in
  src-tauri/capabilities/default.json. Forgetting this is the most common
  silent failure for new Rust commands.
- Cmd+S in xterm.js: the terminal-view captures keys; if an edit tab is
  active, focus must be inside CodeMirror, NOT the terminal. The diff panel
  visibility/focus split already handles this — verify on bun tauri dev.
```

---

## Implementation Blueprint

### Data models / types

```typescript
// src/context/diff-panel.tsx — PanelTab widens:
export type PanelTab =
  | { kind: "diff" }
  | { kind: "file"; path: string; line?: number; openedAt: number }
  | { kind: "editor"; editorId: string; path: string; ptyId: string; openedAt: number }
  | { kind: "edit"; path: string; openedAt: number };

// tabKey: edit tabs use `edit:<path>` so the same file as "preview" and
// "edit" can coexist as separate tabs (they intentionally show different
// surfaces).

// src/lib/edit-buffers.ts (new)
export type EditBuffer = {
  /** Last contents written to / read from disk. Compare against the live
   *  CodeMirror doc to derive the dirty flag. */
  baseline: string;
  /** Mtime in millis from the FilePayload at load time. Used to detect
   *  external changes when a save would clobber. */
  baselineMtime: number;
  /** Set true while a save is in flight; blocks re-entrant saves. */
  saving: boolean;
};
```

```rust
// src-tauri/src/file_read.rs — extend FilePayload with mtime; switch
// to strict UTF-8 (lossy decoding is not editor-safe).
#[derive(Debug, Serialize, Clone)]
pub struct FilePayload {
    pub path: String,
    pub contents: Option<String>,
    /// True for both real binaries (null-byte probe) and non-UTF-8 text
    /// — the editor treats both identically in v1 (menu disabled).
    pub is_binary: bool,
    pub too_large: bool,
    pub bytes: u64,
    pub mtime_ms: i64, // NEW
}

pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Inside read_file_bytes, replace the lossy decode with:
//   match std::str::from_utf8(&data) {
//       Ok(s) => Some(s.to_owned()),
//       Err(_) => return Ok(FilePayload { is_binary: true, ... }),
//   }

// src-tauri/src/file_write.rs (new)
#[derive(Debug, Serialize, Clone)]
pub struct WriteResult {
    pub bytes: u64,
    pub mtime_ms: i64,
}

#[tauri::command]
pub fn write_file_bytes(
    project_path: String,
    rel_path: String,
    contents: String,
    /// Optional: if provided, the command checks the on-disk mtime and
    /// rejects with "stale" when it differs. Frontend passes the baseline
    /// it loaded; on conflict the user is offered Reload/Keep mine.
    expected_mtime_ms: Option<i64>,
) -> Result<WriteResult, String> {
    let abs = crate::file_read::resolve_rel(&project_path, &rel_path)?;
    if let Some(expected) = expected_mtime_ms {
        let cur = std::fs::metadata(&abs)
            .map(|m| crate::file_read::mtime_ms(&m))
            .map_err(|e| format!("stat: {e}"))?;
        if cur != expected {
            return Err("stale".into());
        }
    }
    let bytes = contents.as_bytes();
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("file exceeds 1 MiB write cap".into());
    }
    std::fs::write(&abs, bytes).map_err(|e| format!("write: {e}"))?;
    let meta = std::fs::metadata(&abs).map_err(|e| format!("stat: {e}"))?;
    Ok(WriteResult {
        bytes: meta.len(),
        mtime_ms: crate::file_read::mtime_ms(&meta),
    })
}
```

### Tasks (in execution order)

```yaml
Task 1: Rust — read/write commands
  - MODIFY: src-tauri/src/file_read.rs
    - Add `mtime_ms: i64` to FilePayload (Unix millis).
    - Extract `pub(crate) fn mtime_ms(meta: &Metadata) -> i64` helper
      (reusable by write).
    - Replace the current `String::from_utf8_lossy` path with strict
      `std::str::from_utf8`. On `Err`, return the same shape as the
      binary branch (`is_binary: true, contents: None`). Rationale:
      the editor MUST NOT load lossy U+FFFD content because saving it
      back would corrupt the file. Treating non-UTF-8 as "binary" keeps
      the v1 menu logic single-branch (Edit disabled).
    - Make `resolve_rel` `pub(crate)` if it isn't already.
  - CREATE: src-tauri/src/file_write.rs
    - write_file_bytes — symmetric to read_file_bytes.
    - resolve_rel reused via `pub(crate)`.
    - 1 MiB write cap. UTF-8 only (the contents arg is `String`).
    - Optional expected_mtime_ms for stale-write detection.
  - MODIFY: src-tauri/src/lib.rs — register write_file_bytes; declare
    the new module.
  - MODIFY: src-tauri/capabilities/default.json — allow new command.

Task 2: Frontend — tab kind + cancellable close-guard
  - MODIFY: src/context/diff-panel.tsx
    - Widen PanelTab with `{ kind: "edit"; path: string; openedAt: number }`.
    - tabKey: `edit:<path>`.
    - Add `openEdit(projectPath, rel)` — dedup by tabKey, focus existing
      tab if present, else push new and activate.
    - Add `findEditTabKey(projectPath, rel)` (parallel to findEditorTabKey).
    - INTRODUCE close-guard registry (the existing `onBeforeClose` is
      fire-and-forget and runs *before* a synchronous splice — it cannot
      cancel. We need a real gate.) Shape:
      ```ts
      type CloseGuard = (tab: PanelTab) => Promise<"close" | "keep">;
      function registerCloseGuard(key: string, guard: CloseGuard): () => void;
      ```
    - REWRITE `closeTab` and `clearProject` to be `async`. Each iterates
      the keys it's about to splice, awaits the guard if registered;
      `"keep"` aborts the operation (or skips that single tab in the
      multi-tab clearProject case). Default behaviour with no guard
      registered is unchanged ("close" immediately).
    - REWRITE `closeActiveTab` to be `async` and forward.
    - Existing fire-and-forget `onBeforeClose` hooks (used by editor-pty
      for SIGHUP) stay — they run *after* the guard resolves "close".
  - MODIFY callers: any sync `panel.closeTab(...)` / `panel.clearProject(...)`
    becomes `void panel.closeTab(...)` (or awaited where ordering matters
    — App.tsx project-close path).

Task 3: Frontend — buffer registry + dirty signals
  - CREATE: src/context/edit-buffers.tsx
    - Map<path-key, { baseline, baselineMtime, saving, dirty }>.
    - Path-key = `${projectPath}::${rel}`.
    - Exposes: `register(key, baseline, mtime)`, `markDirty(key, isDirty)`,
      `setSaving(key, bool)`, `updateBaseline(key, contents, mtime)`,
      `unregister(key)`, `dirty(key)` reactive read.
    - Crucial: dirty flag is what the tab strip reads to render the `•`.
    - This context is intentionally separate from diff-panel so the editor
      component can mutate buffer state without thrashing the tabs store.

Task 4: Frontend — EditorTab component
  - CREATE: src/components/diff-panel/editor-tab.tsx
    - On mount: invoke read_file_bytes, populate baseline + buffer state,
      lazy-import codemirror modules, mount EditorView into a div ref.
    - Language pack chosen via extension (tiny switch in
      src/lib/cm-language.ts — JS/TS/TSX (lang-javascript with flags),
      JSON/MD/CSS/HTML/Rust/Python/YAML/SQL; default = plaintext.
      .toml/.sh/.zsh/.bash/.fish all fall through to plaintext in v1).
    - Listen to docChanged in an updateListener; compute dirty as
      `view.state.doc.toString() !== baseline`.
    - keymap entries:
      * Mod-s → save() (preventDefault).
      * indentWithTab.
    - save(): write_file_bytes; on stale → show banner + reload/keep mine.
      On success → updateBaseline, markDirty(false).
    - External-change banner: subscribe to fs:event:<projectPath>; if any
      event names this rel path AND the baselineMtime is older than the
      observed disk mtime AND the buffer is dirty → show banner. (Read
      mtime via a fresh read_file_bytes; ignore other events.)
    - On unmount: dispose EditorView, unregister buffer.
  - CREATE: src/lib/cm-language.ts — extension → language extension factory.
  - CREATE: src/lib/cm-singleton.ts — lazy `import("codemirror")` pieces.
    Cache language factories so re-opening the same kind of file is fast.

Task 5: Frontend — Diff panel integration
  - MODIFY: src/components/diff-panel/diff-panel.tsx
    - Add `<Match when={activeTab()?.kind === "edit"}>` rendering EditorTab.
      MOUNT edit tabs the same way editor-pty tabs are mounted today:
      absolute-positioned, `visibility: hidden` when inactive, never
      unmounted on tab switch. CodeMirror's EditorView is single-instance
      per tab; tearing down on switch loses scroll/undo state.
    - Tab strip: render Pencil icon for edit tabs; if buffer is dirty
      prepend a `•` to the label.
    - In EditorTab's onMount, call
      `panel.registerCloseGuard(tabKey, async (tab) => …)` and unregister
      in onCleanup. The guard:
        1. If buffer is clean → return `"close"` immediately.
        2. Else open the dirty-prompt dialog and await user choice.
        3. Save → run save(); if save succeeds return `"close"`; if save
           fails toast the error and return `"keep"`.
        4. Discard → return `"close"`. Cancel → return `"keep"`.
  - DIALOG: src/components/confirm-dialog.tsx (new). Minimal hand-rolled
    overlay following the same pattern as ContextMenu (fixed-position,
    Escape closes as Cancel, click-outside cancels). NOT a full design-
    system component — just enough for this prompt and any future ones.
  - TOAST: if no toast helper exists in src/lib, add a tiny
    src/lib/toast.ts: window event bus + a Toaster component mounted
    once in App.tsx. Three slots, 4s auto-dismiss. Used here and reusable
    for save/load errors. (Skip if a toast helper already exists — grep
    src/ for `toast` first.)

Task 6: File-tree right-click — "Edit" entry
  - MODIFY: src/components/file-tree/file-tree.tsx (around line 377)
    - For non-dir entries, push an "Edit" item right after "Open in preview".
    - Disabled when the file looks binary or too large. Heuristic: cheap
      extension check first (.png/.jpg/.pdf/.zip/...); fall through to
      relying on read_file_bytes returning is_binary or too_large after
      the click (with a toast on failure).
    - icon: Pencil from lucide-solid.
    - onClick: diffPanel.openEdit(projectPath, toRel(m.path)) and
      diffPanel.openPanel(projectPath).

Task 7: xterm.js cmd-click → choose preview, NOT edit
  - VERIFY ONLY: existing xterm-file-links.ts already routes to
    `diffPanel.openFile`. Don't change it. Edit is opt-in via right-click;
    cmd-click in the terminal should keep doing read-only preview.

Task 8: Keybindings + project-close wiring
  - MODIFY: src/App.tsx
    - Cmd+W on an active edit tab triggers `void panel.closeActiveTab(...)`.
      The dirty-prompt is owned by the registered close guard, so the
      global keybinding stays a single line.
    - The "close project" handler (existing handleCloseProject) currently
      calls `panel.clearProject(path)` synchronously. After Task 2's
      rewrite, it must `await panel.clearProject(path)` and abort the
      project removal if it returns a "kept" signal (extend clearProject
      to return `Promise<{ kept: number }>` so the caller knows to
      cancel). Closing the project from the project tab strip uses the
      same path.

Task 9: Polish (defer to Sprint 13 if time-pressed)
  - Status pill in the diff-panel tab strip showing "Saved" 1.5s after a
    successful write (mirror the line-flash pattern from FilePreview).
  - Undo/redo keybindings (CM6 has them by default — just verify Mod-z /
    Mod-Shift-z don't conflict with anything global).
```

### Integration points

```yaml
TAURI_CAPABILITIES:
  - file: src-tauri/capabilities/default.json
  - add: command permission for write_file_bytes

CONTEXT_ORDER (App.tsx):
  ProjectsProvider > SidebarProvider > GitProvider > DiffPanelProvider >
  EditBuffersProvider > OpenInProvider > EditorPtyProvider >
  TerminalProvider > SessionWatcherProvider
  # EditBuffersProvider sits inside DiffPanelProvider so editor tabs can
  # access both. It does NOT need OpenIn or PTY contexts.

DEPENDENCIES (package.json):
  - add: @codemirror/state, @codemirror/view, @codemirror/commands,
         @codemirror/language, @codemirror/lang-javascript (covers
         JS/TS/JSX/TSX via flags), @codemirror/lang-{json,markdown,css,
         html,rust,python,yaml,sql}
  - add: @lezer/highlight (transitive but explicit pin avoids dup)
  - DO NOT add: the meta `codemirror` package — it only re-exports
    `basicSetup`, which pulls autocomplete/tooltips/search we don't ship.
  - DO NOT add: @codemirror/legacy-modes this sprint (TOML/shell deferred).
```

---

## Validation Loop

### Level 1: syntax

```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

### Level 2: manual

```bash
bun tauri dev
```

1. Right-click `src/main.ts` → "Edit" appears between "Open in preview"
   and "Open in".
2. Click "Edit" → tab opens with the file in CodeMirror, line numbers,
   syntax highlighted.
3. Type a character → `•` appears in the tab title.
4. ⌘S → `•` disappears; the Git-changes tab updates the file's badge to
   `M` within 1 second (existing fs watcher + git status flow).
5. Right-click another file → "Edit" → second tab. Switch between them
   freely. Buffer contents persist across switches (CM EditorView is not
   disposed).
6. Modify file externally (`echo foo >> src/main.ts` in a real shell) while
   buffer is clean → editor reloads silently. While buffer is dirty →
   banner appears with [Reload] / [Keep mine].
7. Try ⌘S after external change without reloading → toast: "File changed
   on disk. Reload first or click Keep mine to overwrite."
8. Close project tab while a buffer is dirty → confirm dialog: Save /
   Discard / Cancel. Cancel keeps everything; Discard closes; Save writes
   then closes.
9. Right-click `assets/logo.png` → "Edit" is disabled with tooltip
   "Binary file".
10. Open a 2 MiB file → "Edit" is disabled with tooltip "File too large
    (>1 MiB)".

### Level 3: edge cases

- [ ] Save a file that was deleted on disk just before the write → the
      write recreates it; the watcher fires `created` then `modified`.
      Acceptable. (No special handling.)
- [ ] Save inside a file whose parent dir was removed externally →
      write_file_bytes returns an error; toast surfaces it; tab stays open
      and dirty.
- [ ] Two edit tabs on the same file at once — prevented by dedup on
      `edit:<path>`. Re-clicking "Edit" focuses the existing tab.
- [ ] Race: external write fires `fs:event` AFTER our save but with the
      same mtime we just observed. Don't loop into "external change"
      banner. Implementation: when our save returns a new mtime, store it
      as the baseline immediately so the next watcher event with that
      mtime is a no-op for the editor tab.
- [ ] CodeMirror language package fails to load (offline / network blip
      after first run shouldn't matter — it's bundled, but in a future
      lazy-fetch world): fall back to plaintext, log warn.
- [ ] Cmd+S inside the file tree (not the editor) — should NOT save. CM
      keymap is scoped to the EditorView via @codemirror/view's keymap
      extension. The keymap only fires when CM has focus.

---

## Anti-Patterns to Avoid

- ❌ Don't repurpose the `kind: "file"` preview tab to be editable. Keep
  preview read-only. The two surfaces have different mental models (peek
  vs. modify) and different keybinding expectations. Use `kind: "edit"`.
- ❌ Don't auto-save on blur, on tab switch, or on any timer. ⌘S only.
  Auto-save would silently overwrite files Claude is in the middle of
  editing through its Bash tool — a recipe for data loss.
- ❌ Don't open a new fs watcher for the edit tab. The per-project watcher
  in fs.rs already covers everything we need.
- ❌ Don't add Monaco. It's ~2 MB of JS and ships its own worker pool —
  way over budget for a single-tab use case.
- ❌ Don't store buffers in SQLite or localStorage. They are deliberately
  in-memory only.
- ❌ Don't ship LSP / diagnostics / completion. CodeMirror's bracket
  matching + indent + syntax highlight is the entire feature surface.
- ❌ Don't try to handle non-UTF8 files. The Rust read path treats them
  as `is_binary: true`; the menu surfaces the same disabled tooltip.
- ❌ Don't fire dirty prompts from the existing `onBeforeClose` hook —
  it's fire-and-forget and runs *before* a synchronous splice. Use the
  new cancellable `registerCloseGuard` API instead. Hooks remain valid
  for cleanup that must always run after a confirmed close (PTY kill,
  buffer unregister).
- ❌ Don't forget the capabilities/default.json entry for write_file_bytes.
  Tauri will silently 404 the invoke without it.

---

## Confidence

**8/10** — read_file_bytes is already in place, the diff-panel tab union
is well-understood, fs watcher + dirty-banner reuse drops a lot of
incidental complexity, and CodeMirror 6 is well-documented for the
narrow surface we need. Risks:

- Solid + CodeMirror lifecycle bugs (re-mounting on tab switch). Mitigated
  by the `visibility:hidden` pattern PRP 007 already established for
  EditorPtyView — we keep the EditorView alive while the tab is hidden.
- mtime granularity on macOS APFS is good (nanosecond), but on other
  platforms we may see false-positive "stale" rejects. Acceptable for
  v1; documented in sprint results.
- ⌘S keymap conflict with global app shortcuts. None today, but worth a
  manual sanity pass with the diff panel toggle (⌘⇧D) and sidebar
  toggle (⌘B).

## Notes

- Future follow-ups (out of scope here):
  * Inline find/replace (CM6 has `@codemirror/search` — ~20 KB).
  * Image preview placeholder for the disabled "Edit" entry on binaries.
  * Show a warning ribbon when the file is gitignored (editing build
    artifacts is usually a mistake).
  * Surface the editor in the file-tree's double-click flow as an opt-in
    user setting (`localStorage["fileTreeDoubleClick"] = "preview" |
    "edit"`). Default stays "preview".
