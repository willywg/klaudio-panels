# PRP 017: Stop secondary terminals from stealing focus on project re-entry

> **Version:** 1.1
> **Created:** 2026-05-08
> **Updated:** 2026-05-11 — added focus-bus for user-action tab activation
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

**What still doesn't focus on purpose**:

- Project switch back into a project (App.tsx:202-221).
- Auto-resume of last session on project open.
- Shell-panel auto-spawn of the first tab when the panel opens
  (shell-terminal-panel.tsx:37-47) — the user opened the panel, but
  if focus jumped immediately we'd race with whatever they were
  doing before clicking the panel toggle.

QA additions (on top of the original checklist):

- New shell tab "+": focuses immediately, can type without clicking.
- Shell tab strip header click: focuses the target shell.
- "Open in <editor>" on a file: focuses the editor PTY.
- Editor tab strip click between two editor PTYs: focuses target.
- Editor tab strip click on a file-preview tab: doesn't crash and
  doesn't steal focus (no-op — file preview is not a terminal).

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
