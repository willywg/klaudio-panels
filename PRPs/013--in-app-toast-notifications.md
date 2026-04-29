# PRP 013: In-app toast notifications

> **Version:** 1.0
> **Created:** 2026-04-29
> **Status:** Draft
> **Tracks:** [#29](https://github.com/willywg/klaudio-panels/issues/29)
> **Builds on:** [PR #24 (phase 1)](https://github.com/willywg/klaudio-panels/pull/24), [PR #28 (phase 2)](https://github.com/willywg/klaudio-panels/pull/28)

---

## Goal

When the Klaudio Panels window is **focused**, surface notifications
(`stop`, `permission_request`, `idle_prompt`) as in-app toasts
anchored top-right under the titlebar, instead of as macOS native
banners. The OS banner path stays exactly as it is for the
window-blurred case.

## Why

- The macOS Notification Center banner is the right tool when the
  user isn't looking at Klaudio. It is the wrong tool when the
  user is right here — it competes with system notifications from
  every other app, the click target doesn't deep-link cleanly back
  to the originating project, and the AppleScript-fired banner
  shows the wrong source app icon (a side effect of [#25](https://github.com/willywg/klaudio-panels/issues/25)).
- Warp's terminal handles the same family of events with an
  in-window indicator when its window is focused. We mirror the
  pattern.
- Chime, amber ring on the project avatar, and Dock badge already
  cover the at-a-glance "still pending" affordance after the toast
  disappears. The toast is *additional* visual context, not a
  replacement for those.

## What

A toast queue rendered as a stack of cards in the top-right
corner of the window. Each toast has:

- An icon area (project initial badge, matching the sidebar style).
- Title (`<projectName> · <event-specific text>`).
- Body (event-specific preview).
- Auto-dismiss timer (5s for `stop` and `idle_prompt`, 10s for
  `permission_request`).
- Click → activate the originating project (same effect as clicking
  its avatar in the sidebar) and dismiss the toast.
- An X button in the corner that dismisses without activating.

Stack: vertical, newest on top, max 5 visible — events 6+ replace
the oldest visible toast (no off-screen queue, no buildup of stale
context).

### Success Criteria

- [ ] With Klaudio focused on **project A**, an event from
      **project B** surfaces a toast (no OS banner). Click → switches
      active project to B and dismisses the toast.
- [ ] With Klaudio focused on **project A**, an event from
      **project A** surfaces a toast (still useful — user might be on
      a different tab of A).
- [ ] With Klaudio not focused, an event surfaces an OS banner
      exactly as today. No toast visible if the window is in the
      background — but if the user focuses Klaudio while a toast
      *would* still be live, we don't try to back-fill.
- [ ] Chime + amber ring + Dock badge fire for every event,
      regardless of focus state.
- [ ] `permission_request` toasts use an amber accent and stay 10s.
      `stop` and `idle_prompt` use the neutral panel style and
      auto-dismiss after 5s.
- [ ] X dismisses without activating. Click on the toast body
      activates and dismisses.
- [ ] Multiple toasts stack vertically; the 6th replaces the oldest.
- [ ] Toasts don't collide with the titlebar overlay or the
      collapsible sidebar; they sit cleanly inside the available
      window area.

### Non-goals

- Inline action buttons (Allow / Deny on `permission_request`). That
  needs UN-API click action support, gated on [#25](https://github.com/willywg/klaudio-panels/issues/25).
- Persistent activity log / "recent notifications" panel.
- Coalescing same-project rapid-fire events into a single toast.
  Each event gets its own card; if it gets noisy in practice we
  revisit.

## How

### Frontend — `src/context/notifications.tsx`

New signal alongside the existing `unread`, `focused`:

```ts
type ToastKind = "complete" | "permission" | "idle";
type Toast = {
  id: number;
  kind: ToastKind;
  projectPath: string;
  title: string;
  body: string;
  // Set at enqueue time (Date.now() + autoDismissMs); used to skip
  // toasts whose timer fired during the gap between window blur
  // and the next focus tick.
  expiresAt: number;
};
const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
```

Constants:

```ts
const MAX_VISIBLE = 5;
const AUTODISMISS_NEUTRAL_MS = 5000;
const AUTODISMISS_PERMISSION_MS = 10000;
```

Actions:

- `enqueueToast(t: Omit<Toast, "id" | "expiresAt">) => void` — assigns
  monotonic id + computes `expiresAt`, prepends to the queue,
  truncates to `MAX_VISIBLE` (drops oldest), and schedules a
  `setTimeout` to call `dismissToast(id)`. The timer handle lives
  in a module-scoped `Map<id, ReturnType<typeof setTimeout>>` so
  early dismissal can clear it.
- `dismissToast(id: number) => void` — removes from queue, clears
  pending timer.

`alertProject(projectPath, title, body, kind)` (refactored from
today's signature):

```ts
const here = focused() && resolver.isActiveProject(projectPath);
if (!here) markUnread(projectPath);

if (focused()) {
  enqueueToast({ kind, projectPath, title, body });
} else {
  void invoke("notify_native", { title, body }).catch(() => {});
}
```

Strict two-state policy: focused → toast, blurred → OS banner. No
in-between. The `hasTabInProject` callback used in v1.4.1 to
suppress the banner when the user had a tab open is dropped — its
job (give the user a quiet way back when they alt-tab briefly) is
already covered by the chime + amber ring + Dock badge that fire
unconditionally.

Callers pass `kind`:

- `handleComplete` → `kind: "complete"` (neutral, 5s).
- `handleAgentEvent` `permission_request` → `kind: "permission"`
  (amber, 10s).
- `handleAgentEvent` `idle_prompt` → `kind: "idle"` (neutral, 5s).

### `ProjectResolver` shape

```ts
type ProjectResolver = {
  isActiveProject: (projectPath: string) => boolean;
  resolveOpenProject: (cwd: string | null) => string | null;
  activateProject: (projectPath: string) => void;
};
```

`hasTabInProject` from v1.4.1 is dropped — the simplified
suppression model doesn't need it. `App.tsx` wires `activateProject`
to `setActiveProjectPath`; the existing project-switch effect
already runs `markRead(p)` so the amber ring clears as a side
effect of the toast click.

### Frontend — `src/components/notification-toast-stack.tsx` (new)

Single component renders the stack:

```tsx
<div class="fixed top-12 right-4 z-50 flex flex-col-reverse gap-2 pointer-events-none">
  <For each={notifications.toasts()}>
    {(toast) => <NotificationToast toast={toast} />}
  </For>
</div>
```

`top-12` ≈ titlebar (40px) + 8px breathing room. `flex-col-reverse`
+ prepend-on-enqueue means newest renders at the top of the stack
visually. `pointer-events-none` on the wrapper, `pointer-events-auto`
on each toast, so blank space between them doesn't block clicks on
content underneath.

### Frontend — `src/components/notification-toast.tsx` (new)

```tsx
function NotificationToast(props: { toast: Toast }) {
  const notifications = useNotifications();
  const accent = props.toast.kind === "permission"
    ? "border-amber-400/60 ring-1 ring-amber-400/40"
    : "border-neutral-700/60";

  return (
    <div
      role="status"
      class={`pointer-events-auto w-80 rounded-md border bg-neutral-900/95 backdrop-blur px-3 py-2.5 text-sm shadow-xl ${accent} animate-in slide-in-from-right-4 fade-in`}
    >
      <button
        type="button"
        class="absolute top-1 right-1 p-1 text-neutral-500 hover:text-neutral-200"
        onClick={(e) => { e.stopPropagation(); notifications.dismissToast(props.toast.id); }}
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
      <button
        type="button"
        class="block w-full text-left"
        onClick={() => {
          notifications.activateAndDismiss(props.toast);
        }}
      >
        <div class="font-medium text-neutral-100 pr-4 truncate">{props.toast.title}</div>
        <div class="mt-0.5 text-xs text-neutral-300 line-clamp-2">{props.toast.body}</div>
      </button>
    </div>
  );
}
```

`activateAndDismiss(toast)` lives in the context, calls the
resolver's `activateProject` and then `dismissToast(toast.id)`. We
keep the dismissal sequencing inside the context so the component
can stay dumb.

Tailwind animations: `animate-in slide-in-from-right-4 fade-in` is
the `tailwindcss-animate` recipe; check whether the project already
has it. If not, fall back to a CSS keyframe in
`src/styles/animations.css` (or inline style — three lines).

### Mount point — `src/App.tsx`

Add the stack right after the `<Titlebar>` block. Position is
window-fixed (`position: fixed`), so logical-tree placement only
matters for context access (it must be inside
`<NotificationsProvider>`).

### Tests

No automated frontend tests in this repo today (Sprint 03 retro
documents the tradeoff). Validation is via the success criteria
above run in `bun tauri dev`:

1. Focused, different project event → toast appears, click switches
   project + dismisses.
2. Focused, same project event → toast still appears.
3. Blurred → OS banner.
4. Multiple events in 2s → stack of 3+ toasts; 6th replaces oldest.
5. X on toast → dismisses without project switch.
6. Permission toast: amber accent, 10s duration.

## Risks

- **`focused()` race**: an event arrives at the exact moment the
  user blurs the window. Today's behavior fires the OS banner. With
  toasts, an event during the focus → blur transition might enqueue
  a toast that's invisible (window blurred) and never seen. Two
  options: (a) on focus restore, dump expired toasts only — keep
  any that are still in-window time so the user sees what arrived
  while they blinked; (b) accept the gap. Choosing (a) — minimal
  cost (just don't auto-dismiss while blurred; the existing
  `expiresAt` model handles it once we check the timestamp on focus
  restore).

- **Layering with the diff panel** (Sprint 04): the toast stack
  uses `z-50` and is fixed-positioned. The diff panel doesn't lay
  over the right edge of the window, so they don't compete. Re-check
  if/when the diff panel implementation lands.

- **No-OS-banner-when-blurred-but-has-tab path is a behavior
  change**: today, blurred-with-tab still fires the OS banner if
  `!focused()`. The proposed change keeps it silent (chime + ring +
  badge only), reasoning that "I have a tab open *and* I'm
  alt-tabbed somewhere" is "I'm coming back, don't yell at me." If
  this turns out to be too quiet in practice, revert that branch
  to `notify_native` and only suppress when `focused()`.

## Known limitations

- Toast click activates the *project*, not the originating *tab*.
  The active-project effect picks the remembered tab for that
  project (existing logic), which is "good enough" — but a power
  user might want the toast to take them to the exact tab the
  event fired from. Track as a follow-up if it comes up.

- No "snooze" / "remind me again". Once dismissed, the only
  remaining signal is the amber ring on the avatar.

## Out of scope (track separately)

- Inline Allow/Deny buttons on `permission_request` toasts.
- Persistent activity / history panel.
- Cross-window toast routing (multi-window Klaudio is not on the
  roadmap).
