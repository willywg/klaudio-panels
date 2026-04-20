# Sprint 05 — Open-in editor + file preview tab + terminal cmd+click

> Branch: `sprint-05-open-in-and-preview` (post v0.4.0)
> PRP: [006--open-in-editor-and-file-preview.md](../PRPs/006--open-in-editor-and-file-preview.md)

## Scope

1. Titlebar **"Open in"** dropdown (VS Code, Cursor, Zed, iTerm2, Warp, Xcode,
   Terminal, Ghostty, Sublime, plus Finder). Last-used persists.
2. **Read-only file preview tab** inside the existing diff panel. Tab strip
   on top: `Git changes | <file-tab> | <file-tab>`.
3. **`Cmd`/`Ctrl`-click on file paths inside xterm.js** opens a preview tab.
   Works with `foo.ts`, `src/foo.ts`, `src/foo.ts:42`.

Deferred to Sprint 06: spawn a terminal editor (nvim / helix) in a secondary
PTY mounted in the preview area when the preferred "Open in" app is a
terminal editor.

## New files

- `src-tauri/src/open_in.rs` — `check_app_exists` + `open_path_with` (thin
  wrapper over `tauri-plugin-opener`). macOS-only detection for now.
- `src-tauri/src/file_read.rs` — `read_file_bytes` (1 MiB cap + binary probe).
  Path-traversal guarded via canonicalize-and-prefix check.
- `src/lib/open-in.ts` — hardcoded MAC_APPS list + `localStorage` helpers.
- `src/lib/shiki-singleton.ts` — lazy-loaded Shiki `HighlighterCore` +
  per-language lazy registration + extension-to-lang map.
- `src/lib/xterm-file-links.ts` — `ILinkProvider` factory keyed on a path
  regex. Requires a modifier key inside `activate`.
- `src/context/open-in.tsx` — `OpenInProvider`; detects installed apps once
  on mount, persists the last-used app.
- `src/components/open-in-dropdown.tsx` — split-button dropdown (icon opens
  with last app, caret shows menu).
- `src/components/diff-panel/file-preview.tsx` — Shiki-highlighted preview,
  scrolls to the requested `line` with a 1.2s highlight flash.

## Modified

- `src/context/diff-panel.tsx` — new per-project `tabs` state with `openFile`,
  `closeTab`, `closeActiveTab`, `clearProject` (called on project close).
- `src/components/diff-panel/diff-panel.tsx` — tab strip above the body; the
  diff content becomes one of N tabs.
- `src/components/file-tree/file-tree.tsx` — double-click on a clean file
  opens a preview tab; changed files still focus the diff accordion.
- `src/components/terminal-view.tsx` — registers the xterm link provider
  and disposes it on cleanup.
- `src/components/titlebar.tsx` — mounts the Open-in dropdown next to the
  git pill.
- `src/App.tsx` — wraps the tree in `OpenInProvider`; handles `Cmd+W` to
  close the active preview tab when the panel is open.
- `src/index.css` — Shiki preview styling (line numbers via CSS counter +
  scrollbar + flash animation); `.no-scrollbar` util.
- `src-tauri/src/git.rs` — `is_binary_bytes` + `BINARY_PROBE_BYTES` are now
  `pub(crate)` so `file_read.rs` can reuse them.
- `src-tauri/src/lib.rs` — registers the new modules + invoke handlers.

## Known limitations

- macOS only. Linux/Windows app detection tables unchanged.
- Path regex in the xterm link provider matches any `name.ext` token — will
  occasionally highlight strings like `v0.4.0` as clickable. Cmd+click on
  a non-existent path surfaces a console warning, not a toast.
- Preview does not live-update on fs events. Close + reopen the tab to refresh.

## Manual QA

See PRP §Validation Loop — Level 2.
