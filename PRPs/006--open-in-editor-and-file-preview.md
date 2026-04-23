# PRP: Open-in editor + file preview tab + terminal cmd+click

> **Version:** 1.0
> **Created:** 2026-04-20
> **Status:** In Progress
> **Phase:** Sprint 05 (post Sprint 04, pre Sprint 06)

---

## Goal

Make the app useful for **browsing and jumping out to external editors** without leaving klaudio-panels:

1. A titlebar **"Open in"** dropdown that lists detected desktop editors (VS Code, Cursor, Zed, iTerm2, Warp, Xcode, …) and opens the active project with `tauri-plugin-opener`. Remembers the last choice. Click = open project in last used; click the caret = choose another.
2. A **read-only file preview tab** next to the diff panel. The diff panel becomes a tab strip: `Git changes [+N −M]  |  CLAUDE.md  [+]`. Double-clicking an unchanged file in the tree or `Cmd`-clicking a file path anywhere opens it as a preview tab with Shiki syntax highlighting.
3. **`Cmd`-click on file paths inside the terminal** (xterm.js `registerLinkProvider`) opens them as preview tabs.

Sprint 06 candidate (deferred): spawn a terminal editor (nvim / helix) inside a secondary PTY mounted in the preview area when the user's preferred "Open in" app is a terminal editor.

## Why

- Closes the biggest gap from Sprint 04: "I can see what changed but I can't peek at any other file."
- Keeps user in-flow — no Cmd+Tab to the editor just to read a neighbouring file.
- Replicates the most obvious feature parity with OpenCode, which our users already compare us against.
- Pure additive work: no PTY rework, no conversation-history touching, no new long-running processes.

## What

### Success Criteria

- [ ] Titlebar shows an "Open in" dropdown (icon + caret) to the right of the `+N −M` pill.
- [ ] Dropdown lists only installed apps (checked via `/Applications/<Name>.app` + `which`).
- [ ] Last used app persists in `localStorage["openIn.app"]`. Clicking the icon (not the caret) opens the project directly in the last app.
- [ ] Clicking "Finder" / default reveals the project dir in Finder.
- [ ] The diff panel header has a tab strip. First tab = "Git changes" (unchanged from Sprint 04 UX). Opening a file adds a tab to the right with `<filename> ·<close-x>`.
- [ ] Double-click on an unchanged file in the file tree opens a preview tab (not a diff — since there is no diff).
- [ ] Preview tab renders Shiki-highlighted code, read-only, with line numbers. Dark theme.
- [ ] Binary files / files >1 MiB show a placeholder, not garbage.
- [ ] `Cmd`-click on a path like `src/lib/foo.ts` or `src/lib/foo.ts:42` in xterm.js output opens that file in a preview tab (line number scroll if provided).
- [ ] Preview tabs survive project switches within their project (per-project map) but close when the parent project tab is closed.
- [ ] Cmd+W closes the active preview tab. Cmd+Shift+D still toggles the panel.

---

## All Needed Context

### Project-level references

```yaml
- file: PROJECT.md
  why: Sprint order + architectural constraints
- file: CLAUDE.md
  why: PTY rules, file-state-from-fs rule
- file: PRPs/005--git-and-diff-viewer.md
  why: Diff panel state (DiffPanelProvider + accordion model). We extend it with tabs.
```

### Feature-specific references

```yaml
# OpenCode — verbatim-copyable patterns
- file: ~/proyectos/open-source/opencode/packages/desktop/src-tauri/src/lib.rs
  why: `check_app_exists` (lines 131–219) — mac check via /Applications + `which` fallback.
       `open_path` command (lines 166–193) — thin wrapper over tauri_plugin_opener.
  critical: `tauri_plugin_opener::open_path(path, Some(&app_name))` accepts the
            app display name on macOS and translates to `open -a "<Name>" <path>`.

- file: ~/proyectos/open-source/opencode/packages/app/src/components/session/session-header.tsx
  why: MAC_APPS list (lines 48–81), persistence pattern (persisted Persist.global),
       check-apps effect (lines 171–189).
  critical: `checkAppExists` is called once on mount, result stored per-app in a
            Store so absent apps don't flicker into the dropdown.

- file: ~/proyectos/open-source/opencode/packages/app/src/pages/session/file-tabs.tsx
  why: Tab strip shape. Theirs is heavily integrated with their pierre
       selection/comment system — ignore that. Keep the structure: tabs above,
       content region below, close-x on non-first tabs.

# xterm.js link handler
- url: https://xtermjs.org/docs/api/terminal/classes/terminal/#registerlinkprovider
  why: Proper way to intercept cmd-click on detected ranges.
  critical: ILinkProvider.provideLinks receives line number + callback.
            We match a regex against the line buffer and emit links with
            `activate(event, text)` callback. Modifier check is our job:
            inside `activate`, check `event.metaKey` before opening.

# Shiki for preview
- url: https://shiki.style/guide/install#shiki
  why: Fine-grained highlight of single files with theme + language detection.
  critical: @pierre/diffs already ships a bundled Shiki. Importing Shiki separately
            would ship two copies. Option: reuse @pierre/diffs internals or ship
            a tiny lazy-loaded shiki. Decision: lazy-load shiki/bundle/web via
            dynamic import in preview-tab only — keeps initial bundle small.
```

### Known gotchas & project rules

```
CRITICAL — from CLAUDE.md:
- No SQLite for preview state. localStorage only.
- No parsing PTY output. The cmd+click link detector is xterm-native, not a
  PTY parser. We never inspect bytes; xterm's own buffer API does it.

LIBRARY QUIRKS:
- tauri-plugin-opener: `open_path(path, Some("Visual Studio Code"))` works on
  macOS because `open` knows display names. On Linux, we pass the binary name
  ("code", "cursor"). We only ship macOS flow this sprint — Linux/Windows later.
- xterm.js: registerLinkProvider runs per visible line. Heavy regex = slow scroll.
  Keep the regex simple (no global /g needed per match since we reset lastIndex).
- Shiki lazy-load: `await import("shiki")` costs ~1.5MB parsed JS. Cache the
  highlighter instance across tabs to avoid re-paying the cost.
- @pierre/diffs: already uses Shiki under the hood via its bundled Shadow DOM
  component. Not exported for reuse — treat the lazy Shiki instance as separate.
```

---

## Implementation Blueprint

### Data models / types

```typescript
// src/lib/open-in.ts
export type OpenInApp = {
  id: string              // "vscode" | "cursor" | "zed" | ...
  label: string           // "VS Code"
  openWith: string        // macOS display name passed to tauri-plugin-opener
  iconHint: string        // lucide icon or local svg
  kind: "gui" | "terminal" | "finder"  // terminal kind reserved for Sprint 06
}

// src/lib/preview-tabs.ts
export type PreviewTab = {
  kind: "diff"    // the fixed Git-changes tab
} | {
  kind: "file"
  path: string           // relative to projectPath
  line?: number          // optional scroll target
  openedAt: number
}

// src-tauri/src/open_in.rs
#[tauri::command]
fn check_app_exists(app_name: String) -> bool { /* /Applications check + `which` */ }

#[tauri::command]
fn open_path_with(path: String, app_name: Option<String>) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, app_name.as_deref()).map_err(|e| e.to_string())
}

// src-tauri/src/file_read.rs
#[derive(serde::Serialize)]
struct FilePayload { contents: String, is_binary: bool, too_large: bool, bytes: u64 }

#[tauri::command]
fn read_file_bytes(project_path: String, rel_path: String) -> Result<FilePayload, String>
```

### Tasks (in execution order)

```yaml
Task 1: Rust open-in commands
  - CREATE: src-tauri/src/open_in.rs
    - check_app_exists (macOS) — clone OpenCode lines 195–219
    - open_path_with — thin wrapper on tauri_plugin_opener
  - MODIFY: src-tauri/src/lib.rs — register commands

Task 2: Rust file-read command
  - CREATE: src-tauri/src/file_read.rs
    - read_file_bytes(project_path, rel_path) → { contents, is_binary, too_large, bytes }
    - 1 MiB size cap. Binary detect: first 8KB null-byte probe (reuse is_binary_bytes
      from git.rs via `pub(crate)`).
  - MODIFY: src-tauri/src/lib.rs — register command

Task 3: Frontend lib + context
  - CREATE: src/lib/open-in.ts — MAC_APPS list + BADGE/localStorage helpers
  - CREATE: src/context/open-in.tsx — detection effect, persisted app, openCurrent()
  - CREATE: src/lib/preview-tabs.ts — types
  - MODIFY: src/context/diff-panel.tsx — add tabs state (Map<projectPath, PreviewTab[]>,
    activeTab per project, openFile(rel, line?), closeTab(idx))

Task 4: UI — "Open in" dropdown in titlebar
  - CREATE: src/components/open-in-dropdown.tsx
    - Split button: left = icon (opens w/ last), right = caret (menu)
    - Menu items only when exists[id] === true
    - "Finder" pinned at top
  - MODIFY: src/components/titlebar.tsx — mount next to GitSummaryPill when
    activeProjectPath is set

Task 5: UI — tab strip in diff panel
  - MODIFY: src/components/diff-panel/diff-panel.tsx — hoist header into a
    row of tabs. "Git changes" always first. File tabs render after.
    Active tab drives what renders below.
  - CREATE: src/components/diff-panel/preview-tab.tsx
    - Lazy-load shiki on mount (singleton cache)
    - Render code with monospace + line numbers
    - Binary / too_large placeholders
    - Scroll to `line` prop if provided

Task 6: File tree double-click → preview
  - MODIFY: src/components/file-tree/tree-node.tsx — dblclick was already opening
    the diff (Sprint 04). Change: if file has git status → focus diff accordion
    (existing behavior). If clean → openFile(rel).
  - MODIFY: src/components/file-tree/file-tree.tsx — rewire handleOpen.

Task 7: xterm cmd+click link provider
  - CREATE: src/lib/xterm-file-links.ts — regex + ILinkProvider factory
    `/([\w./-]+(?:\.\w+)+(?::\d+)?)/g`
  - MODIFY: src/components/terminal-view.tsx — attach provider per project.
    activate(event, text): split "path[:line]", resolve to absolute via projectPath,
    call diffPanel.openFile(rel, line) via a broadcast event (terminal-view has
    no direct access to diff-panel context; use a tiny event bus or a prop drilled
    from App.tsx — prefer prop for clarity).

Task 8: Keybindings
  - MODIFY: src/App.tsx — Cmd+W closes active preview tab if non-"diff". Cmd+Shift+D
    unchanged.
```

### Integration points

```yaml
TAURI_CAPABILITIES:
  - file: src-tauri/capabilities/default.json
  - add: shell:allow-open for opener plugin (already present via tauri-plugin-opener)
  - add: command permissions for check_app_exists, open_path_with, read_file_bytes

CONTEXT_ORDER (App.tsx):
  - GitProvider → DiffPanelProvider (now owns tabs) → OpenInProvider → children
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
# 1. Click "Open in" caret — VS Code/Cursor/etc. appear (only those installed).
# 2. Pick Cursor — Cursor opens the project.
# 3. Click the icon (not caret) — Cursor opens again (last used persists).
# 4. Double-click an unchanged file in tree — preview tab appears, file rendered.
# 5. Cmd+click "src/lib/git-status.ts" in an echo inside the terminal — preview tab.
# 6. Cmd+W on preview tab closes it. Git changes tab stays.
# 7. Close project tab — preview tabs for that project are gone on re-open.
```

### Level 3: edge cases

- [ ] File >1 MiB — placeholder, no crash.
- [ ] Binary file (.png) — placeholder.
- [ ] Dropdown with no installed editors (only Finder) — menu still usable.
- [ ] Cmd+click on a path that doesn't resolve — toast error, no tab opened.
- [ ] Shiki fails to load a language — falls back to plaintext.

---

## Anti-Patterns to Avoid

- ❌ Don't try to make the preview editable. Read-only this sprint. Editing is Sprint 07+.
- ❌ Don't parse terminal output for file paths. Use xterm's `registerLinkProvider`.
- ❌ Don't spawn a PTY for terminal editors yet. That's Sprint 06.
- ❌ Don't persist preview tabs. Ephemeral per project lifecycle.
- ❌ Don't use `tauri-plugin-shell` to spawn editors. Use `tauri-plugin-opener`.

---

## Confidence

**8/10** — OpenCode provides a verbatim pattern for #1 (dropdown), xterm's link
provider API is well-documented, and Shiki integration is only novel for us
(but trivial). Biggest risk is bundle bloat from Shiki; dynamic import mitigates.
