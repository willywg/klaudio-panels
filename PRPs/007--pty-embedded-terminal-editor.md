# PRP: PTY-embedded terminal editor inside the preview pane

> **Version:** 1.0
> **Created:** 2026-04-20
> **Status:** Draft
> **Phase:** Sprint 06 (post Sprint 05)

---

## Goal

When the user picks a **terminal editor** (nvim, helix, vim, micro) from the
"Open in" dropdown — or right-clicks a file in the tree and chooses one from
the submenu — the editor spawns inside a **second PTY** whose output renders
in the diff-panel preview area. The preview tab shows a live `nvim <file>`
with real keyboard input, colors, plugins — not a read-only Shiki snapshot.
Closing the tab kills the PTY.

Claude's main PTY and this secondary editor PTY are completely independent:
two xterm.js instances, two pty_open calls, two pty:data channels. Resize,
scroll, focus, and cleanup work per-tab.

## Why

- Closes the loop from Sprint 05: terminal editors in the dropdown currently
  fall through to `open -a nvim`, which fails silently because nvim ships no
  `.app` bundle. Users expecting them to work get nothing.
- Major differentiator vs OpenCode — they don't embed terminal editors.
- Re-uses the PTY infra from Sprint 01 almost verbatim. Low risk, high payoff.
- Unblocks the "edit from inside cc-ui without switching to another window"
  use case for users who live in nvim/helix.

## What

### Success Criteria

- [ ] `nvim`, `helix`, `vim`, `micro` appear in the Open-in dropdown only when
      their binaries resolve via `which` inside the login-shell env.
- [ ] Picking a terminal editor opens a new preview tab labelled `nvim foo.ts`
      (or similar) with a live xterm.js mount; the file is open and editable.
- [ ] The editor PTY inherits the same login-shell env hydration as Claude
      (`TERM=xterm-256color`, `COLORTERM=truecolor`, `$PATH`, `$XDG_*`).
- [ ] Resize is per-tab. When the preview panel is resized or the app window
      changes, the editor PTY resizes; the main Claude PTY is unaffected.
- [ ] Closing the tab (`X`, `Cmd+W`, right-click → Close tab) sends SIGHUP to
      the child so unsaved buffers trigger nvim's swap-file recovery UX on the
      next open.
- [ ] A visible "[editor exited with code N]" banner appears on clean exit.
- [ ] Right-click on an editor preview tab exposes: `Close tab`, `Close other
      tabs`, `Send Ctrl-C`, `Send Ctrl-\\` (escape hatch for frozen editor).
- [ ] Opening the same `editor + file` twice focuses the existing tab instead
      of spawning a duplicate PTY.

## Non-goals

- No built-in editor (Monaco/CodeMirror). The editor is the user's binary.
- No multi-pane / tmux-style splitting. One editor = one tab.
- No persistence across app restarts. Closing the window kills all editor PTYs.
- No cross-platform parity this sprint — macOS only. Linux/Windows in a follow-up.

---

## All Needed Context

### Project-level references

```yaml
- file: PROJECT.md
  why: Sprint plan + PTY / filesystem boundaries
- file: CLAUDE.md
  why: PTY rules ("hydrate env", "current_dir every spawn", "frontend owns
        the id"). Editor PTY must follow the same discipline.
- file: PRPs/002--poc-claude-pty.md
  why: Sprint 01 foundation for pty_open.
- file: PRPs/006--open-in-editor-and-file-preview.md
  why: Preview tab plumbing that this sprint extends.
```

### Existing internal refs

```yaml
- file: src-tauri/src/pty.rs
  why: pty_open / pty_write / pty_resize / pty_kill. The editor command will
       parallel this structure.
- file: src-tauri/src/shell_env.rs
  why: probe_shell_env + merge_shell_env — reused verbatim for editor PTY so
       nvim's plugins can find `rg`, `node`, user LSPs.
- file: src/context/terminal.tsx
  why: Tab store pattern (Map by id, sessionId correlation). The editor tabs
       live in their own store, NOT mixed into this one — different lifecycle.
- file: src/components/terminal-view.tsx
  why: xterm.js mount pattern. Will be generalized or duplicated.
- file: src/context/diff-panel.tsx
  why: PanelTab union. New variant `"editor"` with `{ binary, file, ptyId }`.
```

### Known gotchas

```
CRITICAL:
- nvim/helix require the shell env with PATH + XDG_CONFIG_HOME. Without them
  plugins fail silently and the user thinks cc-ui is broken. Same
  merge_shell_env as Claude's pty.
- xterm.js WebGL renderer BLANKS OUT when `visibility:hidden`. The main
  terminal already calls `term.refresh(0, rows-1)` on visibility change —
  copy that exact pattern for the editor view.
- portable-pty on macOS: dropping `pair.slave` early is mandatory so the
  master sees EOF on child exit. Already handled in pty.rs — don't deviate.
- Cmd+W must kill the editor PTY, not just hide the tab. Otherwise the
  child keeps running headless forever.

LIBRARY QUIRKS:
- Some editors (helix) require `TERM=xterm-256color` specifically. If we
  leave TERM unset they fall back to a mono mode.
- `vim` probes `$SHELL` for `:shell` command — set it from merge_shell_env.
- `micro` sends OSC 52 for clipboard; we already have xterm's clipboard
  addon — verify it works without extra config.
- First opening of nvim without a config shows a "welcome" screen; resize
  must happen AFTER the first render or it miscalculates the view size.
  Same fit-on-RAF pattern as Claude's terminal-view.
```

---

## Implementation Blueprint

### Data models / types

```typescript
// src/lib/terminal-editors.ts
export type TerminalEditor = {
  id: string;          // "nvim" | "helix" | "vim" | "micro"
  label: string;
  binary: string;      // `which <binary>` — `nvim`, `hx`, `vim`, `micro`
  /** Argv template. `{file}` is substituted with the absolute file path. */
  argv: string[];
};

// src/context/diff-panel.tsx — PanelTab widens:
export type PanelTab =
  | { kind: "diff" }
  | { kind: "file"; path: string; line?: number; openedAt: number }
  | { kind: "editor"; editorId: string; path: string; ptyId: string; openedAt: number };
```

```rust
// src-tauri/src/pty.rs — new command (or generalize pty_open)
#[tauri::command]
pub async fn pty_open_editor(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    project_path: String,
    binary: String,       // e.g. "nvim"
    args: Vec<String>,    // e.g. ["src/foo.ts"]
) -> Result<(), String>
```

The implementation is `pty_open` with the Claude-binary lookup replaced by a
`which` resolve of `binary` inside the shell env. Event channels stay
`pty:data:<id>` / `pty:exit:<id>` — no new schema.

### Tasks (execution order)

```yaml
Task 1: Rust — generalize pty_open
  - REFACTOR: extract spawn_pty helper that takes binary + args. pty_open
    remains the Claude-specific wrapper.
  - ADD: pty_open_editor command that resolves `binary` via the shell-env
    PATH and calls spawn_pty.
  - REGISTER: src-tauri/src/lib.rs invoke_handler.

Task 2: Rust — editor binary resolution
  - EXTEND: shell_env.rs with `which_in_shell(shell_env, binary)` helper so
    we don't shell-out every call. Walk $PATH from the hydrated env.

Task 3: Frontend — editor catalogue
  - CREATE: src/lib/terminal-editors.ts — array of supported editors with
    argv templates.
  - CREATE: src/context/editor-pty.tsx — parallel to TerminalProvider,
    tracking editor PTY tabs (Map<ptyId, {projectPath, file, binary, status}>)
    with same `onData/onExit` subscription pattern.

Task 4: Frontend — "Open in" integration
  - MODIFY: src/lib/open-in.ts — OpenInApp gains an optional `terminalEditor?:
    string` pointing to a TerminalEditor id. When present, the dropdown
    click routes to editor-pty.openEditor(projectPath, file) instead of
    tauri-plugin-opener.
  - MODIFY: src/context/open-in.tsx — availableApps also probes `which` for
    each terminal-editor binary, via a new `check_binary_exists` Rust cmd
    (or reuse check_app_exists with a "binary mode" flag).

Task 5: Frontend — preview panel: editor tab kind
  - MODIFY: src/context/diff-panel.tsx — new `openEditor(projectPath, file,
    editorId)` helper. Creates a PanelTab of kind "editor" with a fresh
    ptyId. Dedup by editorId+file.
  - MODIFY: src/components/diff-panel/diff-panel.tsx — Match on "editor"
    renders new <EditorPtyView />.

Task 6: Frontend — EditorPtyView
  - CREATE: src/components/diff-panel/editor-pty-view.tsx
  - LARGELY COPY: terminal-view.tsx (xterm mount, fit, webgl, clipboard,
    resize, visibility refresh). Substitute: data source is editor-pty
    context; on mount, `invoke("pty_open_editor", { id, project_path,
    binary, args })`; on unmount, `invoke("pty_kill", { id })`.

Task 7: Teardown + race safety
  - On tab close (closeTab from diff-panel.tsx), if tab.kind === "editor",
    fire-and-forget pty_kill before splice.
  - On project close (App.tsx handleCloseProject), clearProject already
    splices tabs; also loop editor tabs to pty_kill.
  - On app quit: Tauri already kills children, but verify.
```

### Integration points

```yaml
CONTEXT_ORDER (App.tsx):
  ProjectsProvider > SidebarProvider > GitProvider > DiffPanelProvider >
  OpenInProvider > EditorPtyProvider > TerminalProvider > SessionWatcherProvider
```

---

## Validation Loop

```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
bun tauri dev
```

Manual:

1. Install nvim (`brew install neovim`) if not present.
2. Open-in dropdown shows Neovim with the real nvim logo (from NSWorkspace —
   if nvim ships no .app, the Lucide Terminal fallback is fine).
3. Click Neovim — preview tab "nvim README.md" appears with a live editor.
4. Type `:q` — tab shows exit code banner; close it.
5. Open 3 files in nvim — 3 tabs; Cmd+W closes active one; others keep PTY.
6. Resize the panel with the split divider — nvim reflows.
7. Open Claude in main pane, open nvim in preview — typing in one doesn't
   echo in the other. Two independent PTYs.
8. Right-click editor tab → "Send Ctrl-C" — nvim beeps; not closed.

Edge cases:

- Binary not on PATH — toast error, no tab opened.
- Very long file path — xterm mount handles truncation via `fit-addon`.
- Editor writes to stdin terminal title (OSC 2) — we let xterm render it;
  we DO NOT parse it (CLAUDE.md rule: never parse PTY output).

---

## Anti-Patterns to Avoid

- ❌ Don't reuse the Claude tab store for editor PTYs. Different lifecycle,
  different correlation with sessions.
- ❌ Don't spawn the editor inside a shell wrapper (`sh -c "nvim foo"`).
  PTY signals and exit codes get mangled.
- ❌ Don't skip the shell-env hydration. Without it nvim's plugins break
  silently and the bug surface widens to "doesn't work on my machine".
- ❌ Don't mount xterm.js twice against the same ptyId. Each tab owns its
  own Terminal instance.
- ❌ Don't ANSI-parse the editor output — not even for the tab title. Use
  the file path as the label. Fancy title sync is out of scope.

---

## Confidence

**7/10** — The PTY plumbing is a copy of an already-working path, but:
- macOS apps with no .app bundle need special icon handling (already falls
  back to the Lucide icon; low risk).
- nvim/helix plugin environments are diverse; a user with a plugin that
  requires an interactive login shell (e.g. tmux integration) may see
  breakage we haven't anticipated.
- Sending signals via `pty_kill` is clean for SIGHUP but the protocol for
  Ctrl-C / Ctrl-\\ context-menu items needs a `pty_write_special(key)`
  helper — trivial but new surface.

Mitigation: ship with nvim + vim + micro first. Add helix after the happy
path is stable. Document the "no plugins visible? check your shell profile"
caveat in docs/sprint-06-results.md.
