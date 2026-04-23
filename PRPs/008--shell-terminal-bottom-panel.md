# PRP 008 — Shell terminal bottom panel

> **Version:** 1.0
> **Created:** 2026-04-21
> **Status:** Ready
> **Phase:** Sprint 07 (replaces the old "Sprint 05: extra free-form terminal" slot in PROJECT.md — renumbered after 04 git/diff, 05 open-in, 06 pty-embedded-editor shipped)

---

## Goal

Add an OpenCode-style bottom terminal dock that runs the user's `$SHELL` (zsh/bash/fish) in the active project's cwd. The dock sits **below** the main split (Claude terminal + diff panel), does **not** steal sidebar width, toggles open/closed from a titlebar button (top-right), and supports multiple independent shell tabs per project. A `+` in the tab strip opens a new shell tab; each tab has an `×` close. Tabs are scoped to the active project — switching projects swaps which tabs are visible. Panel open-state and height persist across restarts.

## Why

- Closes the last obvious gap versus OpenCode's session page — "I need a shell to run `bun test` / `git push` without Cmd-tabbing to iTerm".
- Reuses the PTY machinery we already built for Claude + editor tabs (`spawn_pty`, shell-env hydration, base64-encoded `pty:data:<id>` events). The only new ingredient is a thin spawn command that runs the login shell.
- Unblocks Phase 5 in `PROJECT.md` ("Extra free-form terminal") which was always scoped as a 1-week sprint.
- Gives us a second consumer of the PTY layer — if the abstraction is right, `pty_open_shell` should be a 15-line function.

## What

- Titlebar gets a new icon (top-right, near the `OpenInDropdown`) that toggles the bottom dock. Icon is lucide's `Terminal` (or `SquareTerminal`). Tooltip: "Toggle terminal (⌘J)".
- When opened for the first time in a project (no existing shell tabs), the dock auto-spawns one tab running `$SHELL` in the project cwd.
- Dock layout:
  - Fixed at the bottom of the main area, full width (from sidebar panel's right edge to the window's right edge — it does **not** extend under the projects avatar column or the sidebar panel).
  - Top edge has a 4px vertical resize handle (drag up/down). Min height 120px, max 60 % of window.
  - First row: a tab strip (same visual style as the top `TabStrip` but smaller height — 32px). `+` button on the right, `×` button per tab, and a final `⨯` "close panel" button far right.
  - Second row: the xterm.js viewport for the active tab.
- Tab store is per-project. Killing the last tab of the active project auto-closes the dock (consistent with OpenCode).
- Persistence (localStorage):
  - `shellTerminal.height` — global, default 260.
  - `shellTerminal.open:<projectPath>` — per-project boolean, default closed.
- Keybind: `Cmd+J` (Mac) / `Ctrl+J` toggles the dock for the active project. No-op if no active project.

### Success Criteria
- [ ] Titlebar terminal button toggles dock visible/hidden; state persists per project.
- [ ] First open auto-creates a tab running `$SHELL` in project cwd; prompt appears within ~200ms.
- [ ] `+` opens a second tab; `×` on a tab kills that PTY only.
- [ ] Closing the last tab auto-closes the dock.
- [ ] Dock is resizable by dragging its top edge; height persists across relaunch.
- [ ] Switching project swaps which tabs are visible; PTYs of hidden projects keep running.
- [ ] `Cmd+J` toggles the dock from anywhere (including while xterm has focus).
- [ ] Diff panel + top Claude terminal continue to work unchanged (no regression on Cmd+W / Cmd+Shift+D).
- [ ] Typecheck + `cargo clippy -- -D warnings` clean.

---

## All Needed Context

### Project-level references
```yaml
- file: PROJECT.md
  why: Phase 5 ("Extra free-form terminal") is the lineage for this PRP.
- file: CLAUDE.md
  why: Rule 2 (don't parse PTY output), rule 3 (shell env hydration), rule 9 (multi-PTY w/ tabs). All apply verbatim here.
```

### Feature-specific references
```yaml
- file: ~/proyectos/open-source/opencode/packages/app/src/pages/session/terminal-panel.tsx
  why: Canonical layout — resize handle, tab strip with `+`, auto-create first, close-last-closes-dock, DnD reorder (we skip DnD in v1).
  critical: |
    They use a createStore w/ `autoCreated` guard so the auto-spawn effect
    fires exactly once per open. Copy that pattern — without the guard, the
    effect re-runs as soon as the count drops back to 0 and spawns a new
    terminal you didn't ask for.

- file: src-tauri/src/pty.rs
  why: Reuse `spawn_pty()` — it already owns the PTY size/reader/writer/exit
  machinery. New command is a 15-line wrapper that picks the shell binary
  and calls `spawn_pty` with the hydrated env.

- file: src/context/editor-pty.tsx
  why: Closest existing pattern — a second PTY context that mirrors the
  terminal context shape (openX/kill/write/resize/onData/onExit). Copy its
  skeleton; drop the openEditor/spawnPty split (we spawn eagerly since we
  already have fitted cols/rows by the time the view mounts).

- file: src/components/terminal-view.tsx
  why: Pattern for xterm mount, FitAddon, WebglAddon fallback, ResizeObserver
  debounce, clipboard keybinds. Shell view is ~80 % identical; drop the
  `makeFileLinkProvider` and Claude-specific exit banner.
```

### Current repo state (relevant slice)
```
src-tauri/src/
  pty.rs              # spawn_pty + pty_open / pty_open_editor / write / resize / kill
  shell_env.rs        # get_user_shell / load_shell_env / merge_shell_env / which_in_shell
  lib.rs              # invoke_handler registration
src/
  context/
    terminal.tsx      # Claude PTY tabs (existing)
    editor-pty.tsx    # nvim/helix PTY tabs (existing)
  components/
    titlebar.tsx      # 40px macOS chrome, sidebar toggle lives here
    terminal-view.tsx # xterm for Claude tabs
    tab-strip.tsx     # top tab strip (Claude sessions)
  App.tsx             # Shell() wires providers + splits the main area
```

### Desired changes (files to add/modify)
```
# NEW
src/context/shell-pty.tsx                    # per-project shell tabs store
src/components/shell-terminal/
  shell-terminal-view.tsx                    # xterm mount for one shell tab
  shell-terminal-panel.tsx                   # bottom dock: resize + tabs + view

# MODIFIED
src-tauri/src/pty.rs                         # + pty_open_shell command
src-tauri/src/lib.rs                         # register pty_open_shell
src/components/titlebar.tsx                  # + terminal toggle button
src/App.tsx                                  # + ShellPtyProvider, mount panel, Cmd+J
```

### Known gotchas & project rules
```
CRITICAL — from CLAUDE.md:
- Shell env hydration is mandatory. $SHELL is probed by shell_env::get_user_shell;
  don't hardcode "/bin/zsh".
- current_dir must be the project path so prompts/relative paths are sane.
- Multi-PTY: each tab is an independent child; closing one kills only that PTY.
- Switching tabs/projects toggles visibility, never re-mounts xterm (loses scrollback).
- Subscribe to pty:data:<id> BEFORE invoking pty_open_shell (same race as
  the Claude PTY — first prompt bytes would otherwise be lost).

LIBRARY QUIRKS:
- portable-pty: spawning an interactive shell needs TERM=xterm-256color + the
  cwd set. Some shells (fish) probe $LANG; shell_env::merge_shell_env already
  carries the hydrated locale.
- xterm.js WebGL stops painting when its canvas is `visibility: hidden`.
  Same pattern as terminal-view.tsx: re-fit + refresh + focus on re-show.
- localStorage string-to-number parse — clamp to [120, 0.6 * innerHeight].
```

---

## Implementation Blueprint

### Data models / types
```typescript
// src/context/shell-pty.tsx
export type ShellPtyStatus = "opening" | "running" | "exited" | "error";

export type ShellPtyTab = {
  ptyId: string;
  projectPath: string;
  /** 1-based index within the project; stable label "shell N". */
  index: number;
  status: ShellPtyStatus;
  exitCode: number | null;
  error: string | null;
};
```

### Tasks (in execution order)

```yaml
Task 1 — Rust: pty_open_shell
  - MODIFY: src-tauri/src/pty.rs
  - ADD: fn pty_open_shell(app, state, id, project_path) -> Result<(), String>
  - PATTERN:
      let shell = shell_env::get_user_shell();
      let shell_env = shell_env::load_shell_env(&shell);
      let env = shell_env::merge_shell_env(shell_env, vec![
          ("TERM".into(), "xterm-256color".into()),
          ("COLORTERM".into(), "truecolor".into()),
          ("KLAUDIO_SHELL".into(), "1".into()),
      ]);
      // Login-interactive so the user's prompt / aliases load. zsh/bash
      // both accept "-l -i"; fish uses "-l -i" too. Skip -l if the binary
      // basename is "sh" to avoid surprising POSIX-only shells.
      let args = if shell.ends_with("/sh") { vec!["-i".into()] }
                 else { vec!["-l".into(), "-i".into()] };
      spawn_pty(app, &state, id, shell, args, project_path, env, None, None)

Task 2 — Register command
  - MODIFY: src-tauri/src/lib.rs
  - ADD pty::pty_open_shell to invoke_handler
  - NO capability change needed (pty_open / pty_open_editor are already
    ungated — they're Tauri commands, not fs:/shell: permissions).

Task 3 — Shell PTY context
  - CREATE: src/context/shell-pty.tsx
  - MIRROR: src/context/editor-pty.tsx
  - SIMPLIFY: spawn synchronously inside openTab — we don't need the
    "reserve + spawn later" split because the view already knows its size
    by the time it mounts (the panel has non-zero height when visible).
  - API surface:
      openTab(projectPath) -> Promise<string>   // returns ptyId
      closeTab(ptyId)
      setActiveForProject(projectPath, ptyId | null)
      tabsForProject(projectPath) -> ShellPtyTab[]
      activeForProject(projectPath) -> string | null
      write / resize / onData / onExit / getTab — same shape as editor-pty
  - PROJECT SCOPING: store holds `tabs: ShellPtyTab[]` (flat) plus a
    Map<projectPath, activeId>. No per-project Provider — one global store.
  - INDEX LABEL: when opening tab, compute next index =
      1 + max(existing.index for tabs in same project) — so labels stay
      stable even after closing an inner tab.

Task 4 — xterm view
  - CREATE: src/components/shell-terminal/shell-terminal-view.tsx
  - COPY from components/terminal-view.tsx (Claude variant), DELETE:
      - import / usage of makeFileLinkProvider + useDiffPanel
      - the onExit banner that says "[claude exited ...]"; replace with
        a neutral "shell exited (code N)" via the JSX overlay (same pattern
        as editor-pty-view.tsx) so we don't writeln while xterm is being
        disposed.
  - Use the shell-pty context instead of terminal context.
  - Cmd+W must NOT reach xterm — the panel handles it to close the tab.
    attachCustomKeyEventHandler returns false for key === "w" with meta.

Task 5 — Panel
  - CREATE: src/components/shell-terminal/shell-terminal-panel.tsx
  - STRUCTURE:
      <div style={{height: N px}}>
        <div ResizeHandle />        // drag top edge
        <div TabStrip>              // [tab x] [tab x] [tab x] + ... × panel
        <div class="flex-1">        // xterm for active tab (For loop like
                                    //   App.tsx does for Claude tabs,
                                    //   visibility toggle per tab)
      </div>
  - Auto-create first tab: createEffect watching
      (opened, tabsForProject(projectPath).length)
    If opened && length === 0 && !store.autoCreated -> openTab(projectPath);
    setStore("autoCreated", true). Reset autoCreated when opened goes false.
  - Close-last: createEffect watching tabsForProject(projectPath).length;
    on count 0 after previously >0, if opened() close the panel.
  - RESIZE HANDLE: pointer-down on 4px div, listen pointermove on window,
    commit height on pointerup. Clamp [120, 0.6 * innerHeight]. Persist
    to localStorage in onResizeEnd only (not on every frame).

Task 6 — Titlebar toggle
  - MODIFY: src/components/titlebar.tsx
  - ADD: new button between <GitSummaryPill> and <OpenInDropdown>,
    visible only when hasActiveProject. Uses lucide SquareTerminal icon.
  - Read/write state via a new useShellPanel() hook that returns
    { opened, open, close, toggle, heightFor, setHeightFor }.

Task 7 — Panel context (layout only)
  - CREATE: src/context/shell-panel.tsx (name: ShellPanelProvider)
  - Two concerns:
      * per-project "opened" boolean — persisted to
        localStorage[`shellTerminal.open:${projectPath}`]
      * global height — persisted to localStorage["shellTerminal.height"]
  - Expose openedFor(path) / toggleFor(path) / heightPx() / setHeightPx(n).
  - Why separate from shell-pty context: PTY lifecycle and panel visibility
    have different lifetimes. A project can have running shells while the
    panel is closed (user hid it, shells keep printing). Keeping them in
    separate stores lets us kill all shells on project close without
    touching panel-opened flags, and vice versa.

Task 8 — Wire into App.tsx
  - MODIFY: src/App.tsx
  - Wrap <Shell/> with <ShellPanelProvider><ShellPtyProvider> (outside
    SessionWatcherProvider, same nesting depth as EditorPtyProvider).
  - Inside <main>, after the split container, mount
      <Show when={activeProjectPath() && shellPanel.openedFor(activeProjectPath())}>
        <ShellTerminalPanel projectPath={activeProjectPath()!} />
      </Show>
    BUT: the panel must sit BELOW the split container but still WITHIN
    the flex row that contains the sidebar panel + split, so the sidebar
    is untouched by panel height. Concretely:
      <main row>
        <ProjectsSidebar />
        <div column flex-1>            // NEW wrapper
          <Show when=activeProject>
            <div row flex-1 min-h-0>   // the old split row
              <SidebarPanel />
              <div flex-1>             // Claude terminal + diff panel
              </div>
            </div>
            <Show when=panelOpen>
              <ShellTerminalPanel />
            </Show>
          </Show>
        </div>
      </main>
  - ADD Cmd+J handler next to Cmd+B / Cmd+Shift+D in the existing keydown
    hook. Cmd+J should PREVENT DEFAULT (WebKit's "open Downloads" is Cmd+J
    too but only when nothing's focused; safer to preventDefault).
  - Project close handler: shellPty.killAllForProject(path) — parallels
    editorPty.killAllForProject.

Task 9 — Close-all on window close
  - Panels own the PTYs through shell-pty context; its onCleanup already
    kills every tab. Verify the Provider is unmounted on app quit — same
    guarantee we rely on for editor-pty.
```

### Pseudocode (Rust)

```rust
// src-tauri/src/pty.rs
#[tauri::command]
pub async fn pty_open_shell(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    project_path: String,
) -> Result<(), String> {
    let shell = crate::shell_env::get_user_shell();
    let shell_env = crate::shell_env::load_shell_env(&shell);
    let env = crate::shell_env::merge_shell_env(
        shell_env,
        vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("KLAUDIO_SHELL".into(), "1".into()),
        ],
    );
    let args: Vec<String> = if shell.ends_with("/sh") {
        vec!["-i".into()]
    } else {
        vec!["-l".into(), "-i".into()]
    };
    debug_log::write(
        "shell",
        &format!("id={id} shell={shell} cwd={project_path}"),
    );
    spawn_pty(app, &state, id, shell, args, project_path, env, None, None)
}
```

### Integration points
```yaml
TAURI_REGISTRATION:
  file: src-tauri/src/lib.rs
  add: pty::pty_open_shell to invoke_handler

CONTEXT_WIRING:
  file: src/App.tsx
  wrap: <ShellPanelProvider><ShellPtyProvider> around <Shell/>
  mount: <ShellTerminalPanel> below the main split row

LOCAL_STORAGE:
  keys:
    - shellTerminal.height           (global, string of integer px)
    - shellTerminal.open:<path>      (per-project, "1" | "0")
```

---

## Validation Loop

### Level 1 — fast feedback
```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

### Level 2 — manual integration
```bash
bun tauri dev
```

Steps:
1. Pick any project → main terminal boots as before.
2. Click the Terminal icon in the titlebar (top-right) → bottom panel appears
   with one shell tab named "shell 1". Prompt visible, `pwd` prints project path.
3. Click `+` → second tab "shell 2"; type `ls` — independent scrollback per tab.
4. Drag the top edge of the panel up and down → resizes smoothly; release and
   relaunch → same height restored.
5. Close tab 1 via `×` → only tab 2 remains, PTY for tab 1 dies (verify
   with `pgrep -fl zsh` before/after).
6. Close the last tab → panel auto-closes; localStorage
   `shellTerminal.open:<path>` becomes "0".
7. Re-open via `Cmd+J` → new "shell 1" tab spawns (index resets because
   no tabs remain in that project).
8. Switch project in avatar column → panel shows that project's tabs
   (empty until reopen or auto-spawn fires).
9. Run a long command (`sleep 30`) in a shell tab, close panel, reopen:
   output continues, tab scrollback preserved.
10. Cmd+W with focus in the shell xterm does NOT close Claude's file
    preview (it's handled by the panel instead; in v1 we just don't
    close anything — leaving Cmd+W to Claude panel is fine too, but the
    shell xterm must NOT send literal "w" to the PTY).

Expected:
- No red in devtools console.
- `~/Library/Logs/Klaudio Panels/klaudio.log` has `[shell] id=<uuid> shell=/bin/zsh cwd=<project>` on each open.
- No regressions: diff panel Cmd+Shift+D still works; Claude terminal resizes correctly when dock opens/closes (the ResizeObserver on `TerminalView` re-fits automatically).

---

## Final Checklist

- [ ] `bun run typecheck` passes
- [ ] `cargo check` + `cargo clippy -- -D warnings` clean
- [ ] Manual steps 1-10 above pass
- [ ] `ShellPtyProvider` is the right sibling depth in App.tsx
- [ ] `killAllForProject` is called from `handleCloseProject`
- [ ] PROJECT.md updated (Sprint 05 marked done, this becomes Sprint 07)
- [ ] No new capability permissions required (verify at runtime — no `not allowed by ACL` errors)

---

## Anti-Patterns to Avoid

- ❌ Don't put the dock INSIDE the split container — it would steal height from the Claude terminal and diff panel every time it opens.
- ❌ Don't parse shell output; no link providers, no prompt detection. This is a dumb xterm.
- ❌ Don't share state with `useTerminal()` — that store is Claude-specific (sessionId, label, spawnedAt for JSONL correlation). Shell tabs have none of those concerns.
- ❌ Don't re-mount xterm on tab switch — use the same `visibility: hidden` + `For` pattern as App.tsx's Claude tabs.
- ❌ Don't persist the list of open shell tabs — keeps the project close path simple (kill them all) and avoids "zombie shells from last run" surprises.
- ❌ Don't spawn the shell without `-l -i` — aliases / nvm / starship won't load and the prompt will look broken.

---

## Notes

- Drag-reorder of tabs deferred (OpenCode has it with `@thisbeyond/solid-dnd` — nice, not critical).
- Future: "restore last tab per project" + horizontal split (two shells side by side) — out of scope for v1.
- Future: send selected file path from the file tree into the shell via right-click → "Paste path in terminal".
