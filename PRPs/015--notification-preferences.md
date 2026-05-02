# PRP 015: Notification preferences (kill switch + sounds toggle)

> **Version:** 1.0
> **Created:** 2026-05-02
> **Status:** Draft
> **Tracks:** [#36](https://github.com/willywg/klaudio-panels/issues/36)
> **Builds on:** [PRP 013 (in-app toasts)](013--in-app-toast-notifications.md), [PRP 014 (bell + hover-pause)](014--notification-bell-and-hover-pause.md)

---

## Goal

Give the user a per-channel kill switch over Klaudio's notifications,
exposed inline from the bell popover. Three toggles, persisted in
`localStorage`, honored by the notifications context before any
toast / bell entry / OS banner / sound is produced:

- `notifySessionComplete` — `session:complete` events from the JSONL
  watcher (the noisy one — see #36).
- `notifyPermission` — `permission_request` events from the warp
  plugin (OSC 777). The high-signal path; off by default no, but
  available as an opt-out.
- `playSounds` — chimes for both kinds.

## Why

`session:complete` is JSONL-driven and fires once per Claude
`end_turn` (terminal `stop_reason`). In real agentic loops Claude
reaches `end_turn` after every tool-free reply ("Commit X listo",
"Typecheck passes", "Fix applied"), not just at "task done"
moments. An external user without the warp plugin reported the bell
filling with five "Claude is done" entries in a few seconds while
they were actively reading the same project's transcript.

The right long-term fix is to lean on `permission_request` (warp
plugin) as the primary signal and downgrade `session:complete` to
something quieter — but that's a behavior change with its own
tradeoffs (#36 "out of scope" section). The immediate fix the user
asked for is a kill switch, surfaced where the noise is.

## What

### Preferences module — `src/lib/notifications-prefs.ts` (new)

```ts
export type NotificationPrefs = {
  notifySessionComplete: boolean; // default true
  notifyPermission: boolean;      // default true
  playSounds: boolean;            // default true
};

export function getPrefs(): NotificationPrefs;
export function setPrefs(patch: Partial<NotificationPrefs>): void;
```

Persistence: a single `localStorage` key `notificationPrefs`
holding the JSON object. Missing / malformed → defaults all-on.
Pattern matches `lib/sidebar-prefs.ts` (try/catch around storage
access, default fallbacks).

### Notifications context — `src/context/notifications.tsx`

- Hold a `prefs` signal seeded from `getPrefs()` on context
  creation. Provide `prefs()` and `updatePrefs(patch)` through the
  hook.
- `updatePrefs` writes to `localStorage` via `setPrefs` AND updates
  the signal so consumers re-render in the same tick.
- `handleComplete(payload)`: bail early if `!prefs().notifySessionComplete`.
  Sound is also gated on `prefs().playSounds`.
- `handleAgentEvent(payload)` (only `permission_request` reaches
  here): bail early if `!prefs().notifyPermission`. Sound gated on
  `playSounds`.

The gates apply at the *entry point*, not inside `alertProject`.
That keeps `alertProject` semantics unchanged for any future caller
and means a disabled channel produces zero side-effects (no bell,
no ring, no toast, no banner).

### Settings panel — `src/components/notification-bell.tsx`

The popover gains a two-mode shell:

- **List mode** (default): existing items + "Mark all read".
  Header gains a small ⚙️ gear button on the right of the
  "Notifications" label, opens the settings panel.
- **Settings mode**: replaces the body with three toggle rows.
  Header label switches to "Settings" with a left-arrow back to
  list mode.

**Plugin-aware gating for Permission requests.** Without the warp
plugin no `permission_request` events ever reach the frontend, so an
enabled toggle would lie. Detection runs through a new Tauri command
`is_warp_plugin_installed` (reads
`~/.claude/plugins/installed_plugins.json`, checks for the
`warp@claude-code-warp` key). State is seeded async on context
mount and refreshed every time the settings view opens — covering
the "I just installed the plugin" flow without forcing a Klaudio
restart.

When the plugin is missing:
- The Permission row renders **disabled + visually OFF** regardless
  of the persisted pref. The persisted pref is preserved so it
  takes effect once the plugin is installed.
- The helper text becomes "Requires the warp/claude-code-warp
  plugin. **Install →**" — the link opens the README anchor
  `#permission-requests-recommended-warp-plugin` in the system
  browser via `tauri-plugin-opener`.

Toggle row layout (compact, ~32px tall):

```
[Label                                          ] [switch]
[muted helper text — one line                  ]
```

Three rows:

1. **Task complete** — "Notify when Claude finishes a turn."
2. **Permission requests** — "Notify when Claude needs permission
   to use a tool. Requires the warp/claude-code-warp plugin."
3. **Sounds** — "Play a chime with each notification."

Switch: small pill toggle, ~36px wide, neutral track / accent fill
on. No external dependency — keep it as a styled `<button>`
toggling a class.

### Success criteria

- [ ] Disabling **Task complete** stops bell items / toasts /
      banners / sounds for `session:complete` events. Re-enabling
      restores them on the *next* event (no replay of suppressed
      ones, by design).
- [ ] Disabling **Permission requests** does the same for
      `permission_request` events from the warp plugin.
- [ ] Disabling **Sounds** silences both chimes; toasts / bell /
      banner still appear when their channel is on.
- [ ] Prefs survive Klaudio restart.
- [ ] All-off keeps the app silent (no toasts, no bell entries, no
      OS banners, no chimes) regardless of plugin state.
- [ ] Defaults are all-on (preserves v1.6.0 behavior for users who
      never open settings).
- [ ] Bell popover layout: gear in header, back arrow in settings
      mode, three toggles, "Mark all read" still present in list
      mode.
- [ ] Outside-click and Escape close the popover from either mode.
- [ ] Tab through popover: gear/back focusable; toggles focusable;
      keyboard activates them (Space/Enter).

### Non-goals

- A separate Settings page or window. Bell-local panel only.
- Per-project mute. Global only — see #36 "out of scope".
- Settings sync across devices (no cloud, no JSON export/import).
- Custom sounds / volume control.
- Changing default behavior — every toggle defaults to ON to keep
  existing users in the same place.
- Anything outside notifications (sidebar prefs, theme, etc.).

## How

### Step 1 — `src/lib/notifications-prefs.ts`

```ts
const KEY = "notificationPrefs";

const DEFAULTS: NotificationPrefs = {
  notifySessionComplete: true,
  notifyPermission: true,
  playSounds: true,
};

export function getPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      notifySessionComplete: parsed.notifySessionComplete ?? DEFAULTS.notifySessionComplete,
      notifyPermission: parsed.notifyPermission ?? DEFAULTS.notifyPermission,
      playSounds: parsed.playSounds ?? DEFAULTS.playSounds,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPrefs(patch: Partial<NotificationPrefs>): void {
  try {
    const next = { ...getPrefs(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore — storage is best-effort.
  }
}
```

Defensive `?? DEFAULTS.x` handles the case where a future field is
added and a returning user has only the older subset.

### Step 2 — wire into `notifications.tsx`

Inside `makeNotificationsContext`:

```ts
const [prefs, setPrefsSignal] = createSignal<NotificationPrefs>(getPrefs());

function updatePrefs(patch: Partial<NotificationPrefs>) {
  setPrefs(patch);
  setPrefsSignal(getPrefs());
}
```

`handleComplete`:

```ts
function handleComplete(payload: SessionCompletePayload) {
  if (!prefs().notifySessionComplete) return;
  if (prefs().playSounds) playTaskComplete();
  // ... existing alertProject call
}
```

`handleAgentEvent`:

```ts
function handleAgentEvent(payload: CliAgentEvent) {
  if (payload.event !== "permission_request") return;
  if (!prefs().notifyPermission) return;
  const projectPath = resolver.resolveOpenProject(payload.cwd);
  if (!projectPath) return;
  if (prefs().playSounds) playPermissionRequest();
  // ... existing alertProject call
}
```

Expose `prefs` and `updatePrefs` from the context's return object.

### Step 3 — bell settings panel

Pull the popover body into a small `view` signal: `"list" | "settings"`.
Render the appropriate body inside the existing card:

```tsx
const [view, setView] = createSignal<"list" | "settings">("list");
// Reset to list mode every time the popover opens, so a fresh
// click-on-bell never lands on the settings tab.
createEffect(() => { if (open()) setView("list"); });
```

`<NotificationHeader>`:
- list mode: "Notifications" label + (optional "Mark all read") + ⚙️ button → setView("settings")
- settings mode: ← back button + "Settings" label

`<NotificationSettings>`:
- For each toggle: row with label, helper text, and a `<ToggleSwitch>`.
- `ToggleSwitch` reads `notifications.prefs().<key>` and calls
  `notifications.updatePrefs({ <key>: !current })` on click.

Reuse the existing `text-[12px]` / neutral palette so the panel
visually belongs to the popover.

### Step 4 — README

Move the Notifications section's plugin recommendation up — make it
the first thing the reader sees in that section, with a one-line
"Recommended" call-out. Mention the new prefs panel briefly:
"prefer no notifications? Bell → ⚙️."

## Risks

- **Toggle race with in-flight events.** A user disables Task
  complete the same instant a `session:complete` lands. The signal
  read inside `handleComplete` reflects the latest value (Solid is
  synchronous on signal reads), so the disable wins. No bug, just
  worth knowing.
- **Existing `alertProject` callers.** Today only `handleComplete`
  and `handleAgentEvent` call it. If a future call site is added,
  it's exempt from the toggle by construction. That's intentional
  — toggles describe *channels*, not the underlying primitive.
- **Settings UI inside popover.** Outside-click handler must still
  fire when the user clicks outside while in settings mode. Same
  handler covers both modes (it's keyed off `wrapRef.contains`,
  not the visible body).

## Known limitations

- Restoring defaults requires flipping each toggle individually.
  Cheap to add a "Reset" link if it comes up.
- Plugin detection is filesystem-based — uninstalls done via
  `claude plugin remove` are picked up the next time the settings
  view opens, but a custom marketplace that installs the plugin
  outside `~/.claude/plugins/installed_plugins.json` would falsely
  show as missing.

## Out of scope (track separately)

- Tighter focus-based suppression: when the project's tab is
  active in a focused window, don't emit `session:complete` even
  if the toggle is on (#36 follow-up).
- Per-project mute / per-event severity.
- A live `notify` watch on `installed_plugins.json` (right now we
  re-check on settings-view open, which is enough for the
  install-without-restart UX).
