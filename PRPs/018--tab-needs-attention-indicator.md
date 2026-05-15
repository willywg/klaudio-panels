# PRP 018: Per-tab "needs attention" indicator in the tab strip

> **Version:** 1.2
> **Created:** 2026-05-14
> **Updated:** 2026-05-15 — v1.2: toast / bell click route to the
> originating tab, not just the project. Discovered during QA: clicking
> the toast switched projects but landed on whatever tab was active
> before, defeating the "which tab needs me" cue.
> **Updated:** 2026-05-14 — advisor pass: enumerate all activation
> paths, drop the misleading null-sessionId fallback, spell out the
> clearTabAttention early-return.
> **Status:** Draft
> **Tracks:** [#42](https://github.com/willywg/klaudio-panels/issues/42)
> **Confidence:** 8/10 — small surface (5 files), no new Rust, no new Tauri events, no new IPC. Risk concentrated in correctly enumerating every tab-activation call site (see §4).

---

## Goal

When a project has more than one Claude tab and one of them fires a
notification (`session:complete` or warp `permission_request`) while
the user is looking at a different tab, the tab strip paints an amber
pulse on the dot of the offending tab. The flag clears when the user
activates that tab, types into it, or closes it. Single-tab projects
get no indicator — the project-level amber ring already disambiguates.

## Why

Notifications today are project-scoped: the project avatar gets the
amber ring, the bell records the event, and an OS banner fires when
blurred. Inside a multi-tab project the user has to click each tab to
find the one Claude is asking about. Extending the existing per-tab
status dot (`tab-strip.tsx:14-25`) is the lowest-noise place to land
the "this tab" signal — same visual idiom, same palette family as the
amber permission toast (`notification-toast.tsx:28`).

## What changes

### 1. New tab state — `needsAttention`

`TerminalTab` (in `src/context/terminal.tsx:13-24`) gains:

```ts
needsAttention: boolean
```

Default `false`. Owned by `terminal.tsx` because tabs already live
there; this avoids a parallel `Set<tabId>` in `notifications.tsx` that
would need to listen to tab disposal for cleanup.

Two new methods exported from `useTerminal()`:

```ts
function markTabNeedsAttention(id: string) {
  const tab = store.tabs.find((t) => t.id === id);
  if (!tab || tab.needsAttention) return;
  setStore("tabs", (t) => t.id === id, "needsAttention", true);
}

function clearTabAttention(id: string) {
  const tab = store.tabs.find((t) => t.id === id);
  if (!tab || !tab.needsAttention) return;
  setStore("tabs", (t) => t.id === id, "needsAttention", false);
}
```

The early-return is **load-bearing**: `clearTabAttention` is called
on every xterm `onData` keystroke; without the guard, Solid's
reactive graph dirties on every char even when there's nothing to
clear, dragging dependent memos with it.

Both are no-ops when the id is unknown. `closeTab` doesn't need to
clear explicitly — splicing the tab out of the store drops the flag
with it.

### 2. Wire `notifications.tsx` to the terminal store

`NotificationsProvider` is mounted INSIDE `TerminalProvider` (see
`App.tsx:1056-1063`), so it can `useTerminal()` directly. No new
resolver method, no new prop drilling.

Add two helpers next to `alertProject`:

```ts
// Decide whether the event should raise a per-tab flag and which
// tab to flag. Returns null when no flag should be raised (single-
// tab project, no sessionId match, user is on the tab).
function pickAttentionTarget(
  projectPath: string,
  sessionId: string | null,
): string | null {
  const tabs = term.store.tabs.filter((t) => t.projectPath === projectPath);
  if (tabs.length <= 1) return null;             // single-tab gate
  if (!sessionId) return null;                   // no reliable target
  const target = tabs.find((t) => t.sessionId === sessionId);
  if (!target) return null;
  // Suppress if user is literally looking at it: window focused AND
  // project active AND this tab is its active tab. Same condition
  // shape as `alertProject`'s `here` check. Note: when activeTabId
  // is null (project just opened, no tab picked yet) the equality
  // is false, so the flag is raised — intentional, the user hasn't
  // committed to a tab.
  const here =
    focused() &&
    resolver.isActiveProject(projectPath) &&
    term.store.activeTabId === target.id;
  if (here) return null;
  return target.id;
}
```

**Why drop the null-sessionId fallback.** v1.0 of this PRP fell back
to "flag the project's currently-active tab" when sessionId was null.
That's actively misleading in the common case where the project
*isn't* active: `term.store.activeTabId` is global, so a null-sid
event on project A while the user is on project B would land the dot
on project A's leftmost tab — almost certainly not the tab Claude
is asking about. A wrong-tab pulse is worse than no pulse: it
trains the user to distrust the signal. The project ring + toast +
bell still fire, so the user knows project A wants something — they
just have to look. The fallback was a half-measure; cutting it
costs nothing on warp ≥0.3.0 (which sends session_id reliably) and
avoids the misleading-pulse failure mode on older warp builds.

Called from `handleComplete` and `handleAgentEvent`, AFTER the existing
prefs gate (so disabling `notifySessionComplete` / `notifyPermission`
also disables the dot — the issue calls this out explicitly):

```ts
function handleComplete(payload: SessionCompletePayload) {
  if (!prefs().notifySessionComplete) return;
  // ...existing alert + sound...
  const tabId = pickAttentionTarget(payload.project_path, payload.session_id);
  if (tabId) term.markTabNeedsAttention(tabId);
}

function handleAgentEvent(payload: CliAgentEvent) {
  if (payload.event !== "permission_request") return;
  if (!prefs().notifyPermission) return;
  const projectPath = resolver.resolveOpenProject(payload.cwd);
  if (!projectPath) return;
  // ...existing alert + sound...
  const tabId = pickAttentionTarget(projectPath, payload.session_id);
  if (tabId) term.markTabNeedsAttention(tabId);
}
```

### 3. Tab-strip render

`statusDotClass` (`src/components/tab-strip.tsx:14-25`) takes
precedence on `needsAttention` over the underlying PTY status:

```ts
function statusDotClass(tab: TerminalTab): string {
  if (tab.needsAttention) return "bg-amber-400 animate-pulse";
  switch (tab.status) {
    case "opening": return "bg-indigo-400 animate-pulse";
    case "running": return "bg-green-500";
    case "exited":  return "bg-neutral-500";
    case "error":   return "bg-red-500";
  }
}
```

The function now takes the whole tab instead of just `status`. Caller
at `tab-strip.tsx:46` updates accordingly.

### 4. Reset hooks — every tab-activation path

The rule: any user action that **activates a tab** clears its
attention flag. Project-switch effect's `term.setActiveTab(nextActive)`
is the one activation path that must NOT clear (project switch is
coarser than the per-tab signal). That contract forbids putting the
clear inside `setActiveTab` itself — we'd lose the project-switch
exception — so we enumerate the user-action call sites explicitly,
mirroring the focus-bus pattern from PRP 017.

Every call site that activates a tab in response to a user gesture:

| Trigger | File / handler | Action |
| --- | --- | --- |
| Tab-strip click | `App.tsx:handleActivateTab` | `clearTabAttention(id)` before `setActiveTab` |
| Sidebar session-click on an already-open tab | `App.tsx:handleSelectSession` (the `if (existing) {...}` branch around line 605) | `clearTabAttention(existing.id)` before `setActiveTab` |
| Command palette session-select on an already-open tab | Same code path — `CommandPalette` calls `onSelectSession` which is `handleSelectSession`. Covered by the line above. | — |
| Sidebar session-click that opens a fresh resume tab | `App.tsx:openResumeTab` (via `openTab`) | No action needed — new tab boots with `needsAttention: false`. |
| Cmd+T new tab | `App.tsx:openNewTab` | Same — new tab boots clean. |
| Cmd+1..9 project switch | `App.tsx` keybind → `setActiveProjectPath` | No action — project switch must not clear (see §QA #10). |
| User types into the active Claude xterm | `terminal-view.tsx` xterm `onData` handler | `clearTabAttention(id)` once at the top |
| Tab closes | `terminal.tsx:closeTab` | Free — splicing the tab drops the flag |

The xterm `onData` reset is belt-and-suspenders alongside the
activation clears: it catches the rare case where the user types
into an already-active tab whose flag was set by a `session:complete`
that arrived *after* activation (race: tab was active, blur stole
the window, completion fired, focus returns, user types). The early
return in `clearTabAttention` keeps this cheap.

## Trade-offs

- **Null-sessionId `permission_request` raises no per-tab flag**
  (see §2 reasoning). Project ring + toast + bell still fire. Warp
  ≥0.3.0 sends `session_id`, so this only affects users on very old
  plugin builds.
- **Unpromoted-tab race**: a fresh `claude` tab spawns with
  `sessionId: null` and gets promoted by the session watcher once the
  JSONL file appears (debounce ~200ms). If `session:complete` arrives
  before promotion — fast run, slow watcher — `pickAttentionTarget`
  finds no matching tab and returns null. No per-tab pulse for that
  event; project ring + toast + bell still fire. Hard to hit in
  practice (a real Claude run is longer than the debounce); not
  worth a fallback.
- **No badge count** — out of scope per the issue. A single pulse per
  tab is enough; a counter creates more noise than signal for a
  desktop app that's expected to be foreground most of the time.
- **No sidebar avatar tab-level surface** — the project avatar already
  rings amber. The issue explicitly excludes this.
- **No persistence** — restarting Klaudio drops all `needsAttention`
  flags. Same model as the bell's `unreadItems` (see
  `notifications.tsx:124`). A fresh app start is a clean slate.

## QA checklist

Manual, in `bun tauri dev`. All cases assume `notifySessionComplete`
and `notifyPermission` are enabled (settings default).

1. **Single-tab project — no flag**: open a project with one Claude
   tab. Send it to do something that ends with `session:complete`.
   Confirm: amber project ring fires; tab dot stays green (running)
   or neutral (exited). No pulse.
2. **Multi-tab session:complete on inactive tab**: open two tabs in
   project A. Switch to tab 2. Tab 1's session finishes. Confirm:
   tab 1 dot is amber + pulsing. Tab 2 unchanged. Project A ring
   suppressed because focused + active.
3. **Multi-tab session:complete on active tab**: tab 1 active, tab 1
   itself completes. Confirm: no pulse (user is here).
4. **Multi-tab permission_request with session_id**: tab 1 = `claude
   --resume X`, tab 2 = `claude --resume Y`. From within tab 2 trigger
   a permission prompt (e.g. an `Edit` tool call). Confirm: tab 2 dot
   amber if tab 1 is active. Switch to tab 2 — clears.
5. **Permission_request with null session_id** (older warp build, if
   reproducible): no per-tab pulse anywhere. Project ring + toast +
   bell still fire normally.
6. **Clear by tab-strip click**: pulse on tab 1, click tab 1 in the
   strip. Pulse clears, dot returns to underlying PTY status color.
7. **Clear by sidebar session-click on an open tab**: tab 1 has a
   pulse and corresponds to session X. Click session X's row in the
   Sessions sidebar (which routes through `handleSelectSession` and
   takes the `existing` branch). Pulse clears.
8. **Clear by command palette session-select**: same as #7 but via
   Cmd+K → pick the session. Pulse clears (same handler).
9. **Clear by typing**: rare race — tab 1 is already active when its
   completion fires (e.g. window was blurred when the event arrived,
   so suppression didn't apply). Pulse appears on the active tab.
   Type one character. Pulse clears.
10. **Close clears**: pulse on tab 1, close tab 1 with the X button.
    No crash, no orphaned amber state.
11. **Prefs kill switch**: disable `notifySessionComplete` in
    settings. Repeat scenario 2. Confirm: no toast AND no tab pulse.
    Same for `notifyPermission` + scenario 4.
12. **Project switch does NOT clear**: in project A's tab 1, get a
    pulse. Switch to project B, switch back to project A. The pulse
    on tab 1 should still be there (the user hasn't acknowledged the
    specific tab yet). Project A's ring should clear (existing
    behavior — `notifications.markRead(p)` in the active-path effect).

## Out of scope

- Notification COUNT badge per tab.
- Cross-project tab surfacing on the projects sidebar avatar.
- Sound differentiation per tab.
- Persisting flags across app restarts.
- Showing a tooltip on the pulsing dot ("Claude finished" / "Needs
  permission"). The toast + bell already carry the wording.

## v1.2 addendum — toast / bell click routes to the originating tab

**Why**: v1.1 painted the pulse correctly but the toast click handler
only called `resolver.activateProject(projectPath)`. The project-switch
effect then picked the active tab via `activeByProject` memory — which
is the tab the user had open *before* the alert, not the tab that fired
the alert. So clicking the toast for "Project A · Claude is done" while
sitting in tab 1 landed you back on tab 1, with tab 2 still pulsing.

**The fix**: pass the originating tab through the toast and bell.

1. **`Toast` and `UnreadItem` gain `tabId: string | null`**. Null when
   `sessionId` was missing (older warp builds) or no open tab matched.
   In that case routing degrades gracefully — clicking still activates
   the project, just without preselecting a tab.

2. **`findTabForEvent(projectPath, sessionId)`** — the pure
   payload→tab mapping. Used by BOTH the toast routing and the
   pulse-raising path. Split from the old `pickAttentionTarget` so the
   pulse gate (`shouldRaisePulse`) doesn't suppress toast routing —
   single-tab projects still get routed (no ambiguity, but the toast
   target should still activate that one tab), and "user is here" still
   gets routed (toast was enqueued anyway when focused; clicking it
   should always do something).

3. **`shouldRaisePulse(projectPath, tabId)`** — the gate that used to
   live inside `pickAttentionTarget`. Owns the single-tab-suppression
   and the "user is looking at it" suppression.

4. **`ProjectResolver.activateTab(projectPath, tabId)`** — new resolver
   method implemented in `App.tsx`:
   - Same project as currently active: `term.clearTabAttention(tabId)`
     + `term.setActiveTab(tabId)` + `focusTerminal(tabId)`. The
     project-switch effect doesn't fire, so we clear / activate /
     focus directly.
   - Different project: `activeByProject.set(projectPath, tabId)` first
     so the project-switch effect's "remembered tab" lookup picks our
     target, then `setActiveProjectPath(projectPath)`. The effect
     handles focus via `lastFocusedForProject` memory. Acceptable
     trade-off — if the user was last in a shell/editor for that
     project, focus follows them there, but the Claude tab is still
     visible and its pulse is cleared.

5. **`activateAndDismiss` (toast) and `activateProjectFromBell` (bell)**
   dispatch through `activateTab` when `tabId` is set, else fall back
   to `activateProject`.

**Files touched in v1.2**: `notifications.tsx` (types + helpers +
handlers + resolver type + activateAndDismiss + activateProjectFromBell),
`App.tsx` (resolver impl), `notification-bell.tsx` (one-liner: pass
`item.tabId` through).

**QA added**:

13. **Toast click routes to tab — same project**: 2 tabs in project A,
    tab 1 active. Tab 2 fires session:complete. Toast appears. Click
    the toast. Tab 2 activates, pulse clears, no project switch.
14. **Toast click routes to tab — cross project**: project A has tab 2
    pulsing, user is in project B. Click the toast. Project switches to
    A, tab 2 activates, pulse clears.
15. **Bell click routes to tab**: same as #13/14 via bell entries.
16. **Null-tabId graceful fallback**: simulate a null-sessionId
    `permission_request` (warp <0.3.0). Toast click activates the
    project without preselecting any tab. No crash.

## Risk

Low. Four files touched:

- `src/context/terminal.tsx` — adds one field + two methods.
- `src/context/notifications.tsx` — adds `pickAttentionTarget` and two
  call sites; reads `useTerminal()`.
- `src/components/tab-strip.tsx` — one function signature change.
- `src/App.tsx` — one extra call in `handleActivateTab`.
- `src/components/terminal-view.tsx` — one extra call in `onData`.

No Rust, no new Tauri commands, no event-channel additions. The
existing PTY/notification/session-watcher pipelines are untouched.

The only sharp edge is the provider ordering: `NotificationsProvider`
must remain INSIDE `TerminalProvider` (already is, see
`App.tsx:1056-1063`). If a future refactor flips the order, the
`useTerminal()` call inside notifications will throw on mount. A
comment at the call site documenting the dependency is enough.
