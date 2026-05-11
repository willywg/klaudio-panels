# PRP 017: Stop secondary terminals from stealing focus on project re-entry

> **Version:** 1.2
> **Created:** 2026-05-08
> **Updated:** 2026-05-11 — focus-bus + per-project memory; remove Claude's
> activation-effect focus for full consistency
> **Status:** Draft
> **Tracks:** [#40](https://github.com/willywg/klaudio-panels/issues/40)

---

## Goal

After switching away from a project and back, the keyboard cursor
must land on the Claude tab the user was last using, not on the
shell terminal or the editor PTY. Today the secondary surfaces
(shell, editor) win a focus race and silently capture keystrokes —
which has, on at least one occasion, caused accidental input into
a running `npm run dev`.

## Why

Three terminal surfaces all install the same activation effect:

| File | Line | What it does |
| --- | --- | --- |
| `src/components/terminal-view.tsx` | 297-312 | Claude tab. Synchronous `term?.focus()` at line 302. |
| `src/components/shell-terminal/shell-terminal-view.tsx` | 223-235 | Shell tab. `term?.focus()` at line 230, wrapped in `requestAnimationFrame()`. |
| `src/components/diff-panel/editor-pty-view.tsx` | 261-273 | Editor PTY tab. Synchronous `term?.focus()` at line 268. |

Tabs are mounted-once and visibility-toggled (CLAUDE.md §9), so on
project re-entry **every selected tab in every panel** flips
`props.active=true` simultaneously. Each `createEffect` fires, each
calls `term.focus()`, and whichever runs last owns
`document.activeElement` — typically the shell, because its rAF
defers it past Claude's synchronous call.

There is no coordination between the panels. They are independent
trees rendered side-by-side, so an "ordering" fix would require
inventing cross-tree state. The simpler fix is to admit there is
exactly one **primary** surface (Claude) and let the secondaries
never auto-focus.

## What changes

**Drop the `term?.focus()` line from shell-terminal-view and
editor-pty-view activation effects. Keep refresh + delayed fit.**

Claude's activation effect is unchanged — it still focuses, so the
new-Claude-tab and within-project tab-switch UX remains intact.

```diff
 // src/components/shell-terminal/shell-terminal-view.tsx
 createEffect(() => {
   if (!props.active) return;
   requestAnimationFrame(() => {
     if (disposed) return;
     safeFit();
     try {
       if (term) term.refresh(0, term.rows - 1);
-      term?.focus();
     } catch {
       // ignore
     }
   });
 });
```

```diff
 // src/components/diff-panel/editor-pty-view.tsx
 createEffect(() => {
   if (!props.active) return;
   ...
   safeFit("active-change");
   try {
     if (term) term.refresh(0, term.rows - 1);
-    term?.focus();
   } catch {
     // ignore
   }
   ...
 });
```

That is the entire diff. No new state, no new props, no lifecycle
changes.

## Trade-offs

- **Regression**: clicking the shell or editor tab strip header
  (not the xterm body) no longer auto-focuses the xterm. The user
  must click inside the terminal area before typing. xterm.js's
  built-in canvas-click handler still focuses on direct clicks, so
  the cost is one extra click only when the user activated the tab
  via the strip header. We accept this in exchange for never
  stealing focus from Claude.
- **First-time shell-panel open**: same caveat — the shell xterm
  does not auto-focus when the panel first appears. Again, one
  click resolves it.
- **Editor PTY**: same caveat. The editor PTY is launched inside
  the diff panel; users typically click the editor itself, which
  xterm handles natively.

If QA shows the click-tab-strip path feels broken, the follow-up
is to add `term.focus()` to the tab-strip `onActivate` handler in
the panel components (not back into the activation effect, which
fires on project re-entry too and resurrects the race).

## v1.1 addendum — focus-bus for user actions

The base PR shipped the "remove activation focus from shell + editor"
half. In practice that left a real regression: clicking "+" or a tab
header on the shell/editor strip no longer focused the xterm — which
is the exact UX the user *does* want, because those clicks are
explicit "I want to type here" gestures.

**Rule we're now encoding**: user-action tab activation focuses the
target; passive activation (project switch, auto-resume, auto-spawn)
does not.

A new module `src/lib/terminal-focus-bus.ts` mirrors the existing
`terminal-scroll-bus`: every xterm-hosting view registers a focus
callback keyed by its PTY id on mount, and unregisters on cleanup.
User-action handlers call `focusTerminal(id)`; passive code paths
never call it. Newly-created tabs (where the view hasn't mounted by
the time the handler fires) are queued for ≤500ms and focused as
soon as registration happens.

Call sites added:

| Handler | File | Action |
| --- | --- | --- |
| Shell "+" | `shell-terminal-panel.tsx:handleNewTab` | `focusTerminal(newPtyId)` after `openTab` resolves |
| Shell tab click | `shell-terminal-panel.tsx:handleActivate` | `focusTerminal(ptyId)` after `setActiveForProject` |
| Editor "Open in" (new) | `diff-panel.tsx:dispatchAppOpen` | `focusTerminal(ptyId)` after `openEditor + addEditorTab` |
| Editor "Open in" (existing) | `diff-panel.tsx:dispatchAppOpen` | `focusTerminal(existingTab.ptyId)` for already-open editor PTY |
| Editor tab click | `diff-panel.tsx:onActivate` | `focusTerminal(tab.ptyId)` if `tab.kind === "editor"` |

Views that register: `shell-terminal-view.tsx`, `editor-pty-view.tsx`.
Claude's `terminal-view.tsx` is **not** in the bus — its existing
activation-effect focus already covers both project-re-entry and
user-action focus for Claude tabs, and adding the bus would
double-focus harmlessly but for no reason. If a future change
removes Claude's activation focus, this is where to wire it in.

## v1.2 addendum — per-project memory + Claude joins the bus

v1.1 left the inverse of the original bug in place: if the user was
last typing in the shell in Project A and switched away and back,
Claude's activation effect would still call `term.focus()` on
re-entry and steal the cursor from where the user actually was. The
rule "passive activation never focuses" was right; Claude's
activation effect was the last violator.

**v1.2 changes**:

1. Remove `term.focus()` from Claude's activation effect
   (`terminal-view.tsx:297-312`). Now every view's activation effect
   only does refresh + delayed fit; none of them call focus.
2. Claude joins the focus-bus. `terminal-view.tsx` registers in
   `onMount` and unregisters in `onCleanup`, same shape as shell /
   editor.
3. All three views (Claude, shell, editor) attach a `focus` listener
   on `term.textarea` that calls `recordTerminalFocus(ptyId)`. This
   catches direct clicks on the xterm body (which focus the hidden
   textarea natively), keeping `lastFocusedForProject` accurate even
   when the bus's explicit `focusTerminal` isn't invoked.
4. The focus-bus gains per-project memory:
   - `registerTerminalFocus(id, projectPath, fn)` — registration now
     takes `projectPath` so the bus can attribute focus to a project.
   - `recordTerminalFocus(id)` — update the per-project memory
     without calling focus (used by the textarea focus listener).
   - `lastFocusedForProject(projectPath)` — read accessor.
   - `unregisterTerminalFocus(id)` clears the per-project record if
     the disappearing PTY held it.
5. `App.tsx`'s project-switch effect now does, after picking
   `nextActive` and calling `term.setActiveTab(nextActive)`:
   ```
   const target = lastFocusedForProject(p) ?? nextActive;
   requestAnimationFrame(() => focusTerminal(target));
   ```
   `requestAnimationFrame` is required because focusing a textarea
   inside `visibility: hidden` doesn't stick in WebKit; we need to
   wait one frame for Solid's reactive visibility flip to land.
6. `App.tsx` user-action Claude paths now also call `focusTerminal`:
   - `openNewTab` after `term.openTab` resolves.
   - `openResumeTab` (used by sidebar session-click).
   - `handleSelectSession` when an existing tab is reused.
   - `handleActivateTab` (tab-strip click).
   - `maybeAutoResume` after the auto-resumed tab opens.

Net effect: focus is **never** a side effect of a visibility flip.
It is always triggered by either an explicit user action or the
per-project memory restoration in the project-switch effect. Both
sides of #40 (shell stealing from Claude, Claude stealing from
shell) are closed by the same uniform rule.

**Call-site matrix after v1.2**:

| Trigger | Where focus call lives |
| --- | --- |
| Project switch in | `App.tsx` project-switch effect (rAF) |
| Claude "+" | `App.tsx:openNewTab` |
| Claude session-click | `App.tsx:handleSelectSession` / `openResumeTab` |
| Claude tab click | `App.tsx:handleActivateTab` |
| Claude auto-resume | `App.tsx:maybeAutoResume` (after `openTab`) |
| Shell "+" | `shell-terminal-panel.tsx:handleNewTab` |
| Shell tab click | `shell-terminal-panel.tsx:handleActivate` |
| Editor open-in (new + existing) | `diff-panel.tsx:dispatchAppOpen` |
| Editor tab click | `diff-panel.tsx:onActivate` |
| Direct xterm body click | `term.textarea` focus listener → `recordTerminalFocus` (memory only) |

**What still doesn't focus on purpose**:

- Shell-panel auto-spawn of the first tab when the panel opens
  (shell-terminal-panel.tsx:37-47). The user opened the panel; if
  focus jumped immediately we'd race with whatever they were doing
  before clicking the panel toggle.
- No project active (sidebar empty / home screen).

QA additions (on top of the original checklist):

- New shell tab "+": focuses immediately, can type without clicking.
- Shell tab strip header click: focuses the target shell.
- "Open in <editor>" on a file: focuses the editor PTY.
- Editor tab strip click between two editor PTYs: focuses target.
- Editor tab strip click on a file-preview tab: doesn't crash and
  doesn't steal focus (no-op — file preview is not a terminal).
- **Inverse of #40**: Project A with Claude + shell open, last
  interaction was in shell. Switch to B, switch back to A. Cursor
  must land in the shell, not in Claude.
- **First entry of a project** (this session): focus lands on the
  active Claude tab.
- **Close a shell tab, switch project, switch back**: Claude focuses
  (memory cleared on unregister, falls back to active Claude tab).

## QA checklist

Manual, in `bun tauri dev`:

1. **Reproduce #40 first**: project A with Claude + Shell tabs,
   project B with Claude only. Type into Claude A, switch to B,
   type into Claude B, switch back to A. Confirm cursor is in
   Claude A and the next keystroke goes there. Pre-fix this
   should fail; post-fix it should pass.
2. **New session focus**: from home screen, open a project and
   click "+ New session". Cursor should land in the new Claude
   xterm without a click. (terminal-view.tsx is unchanged so this
   should still work.)
3. **Within-project tab switch**: in a project with two Claude
   tabs, click one then the other from the tab strip. Each click
   should focus the freshly-selected tab. (Unchanged Claude path.)
4. **Shell panel first open**: open a project, hit the shell
   keyboard shortcut / button, click into the shell xterm body —
   typing works. Acceptable: clicking the shell *tab strip header*
   doesn't auto-focus.
5. **Editor PTY in diff panel**: open a file diff, the PTY editor
   appears. Click into it, typing works. Acceptable: it does not
   auto-focus on appearance.
6. **No regression of #38**: rapid project switching does not
   bring back the welcome banner or upward scroll drift.

## Out of scope

- Reworking the multi-panel focus model.
- Restoring "last focused element per project" — the browser does
  not support this natively and emulating it adds state we don't
  need.
- Touching the diff panel's auto-show/hide logic (#7, #38).

## Risk

Low. The change is one deletion per file in two files; everything
else (xterm lifecycle, fit, refresh, scrollback, WebGL) is
untouched.
