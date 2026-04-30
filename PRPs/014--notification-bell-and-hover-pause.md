# PRP 014: Notification bell with unread history + hover-pause toasts

> **Version:** 1.0
> **Created:** 2026-04-29
> **Status:** Draft
> **Tracks:** [#32](https://github.com/willywg/klaudio-panels/issues/32)
> **Builds on:** [PR #30 (in-app toasts)](https://github.com/willywg/klaudio-panels/pull/30), [PR #31 (idle_prompt drop)](https://github.com/willywg/klaudio-panels/pull/31)

---

## Goal

Two related UX additions to close the "I missed the toast" gap that
shows up in real use of the v1.5.x notification system:

1. A **bell** in the titlebar with a list of unread events the user
   hasn't attended to yet. Click an item → activates the originating
   project and the project's items disappear from the list.
2. **Hover-pause** on the toasts: while the cursor is on a toast
   card, its auto-dismiss timer is paused; on mouse leave the timer
   restarts at the full original duration.

## Why

- The toast is the only signal that carries the *what just happened*
  detail. The amber ring tells you which project; the dock badge
  tells you how many; nothing tells you the body. When the toast
  vanishes after 5–10 seconds the user has to switch projects and
  scrub the transcript to reconstruct what fired.
- Long bodies (e.g. `permission_request` with a long `tool_input`
  preview) genuinely need more than 5 seconds to read; without
  hover-pause the user has no way to slow the dismiss down.
- Persistent in-memory log only — a restart starts clean, by
  design. The bell is a "tray for unread," not a history panel.

## What

### Bell — visual + interaction

- `Bell` icon from lucide-solid in the right cluster of the
  titlebar, between the existing search input and the OS open-in
  dropdown. Same hover affordance as the other titlebar buttons.
- Red badge overlay on the icon when `unread > 0`, capped at "9+".
- Click → popover panel anchored under the bell, ~360px wide,
  scrolls if more than ~6 items fit. Closes on outside click or
  Escape.
- Each item: small project initial avatar (matching sidebar style),
  bold project name + dot + event title, body in muted color
  (line-clamp-2), relative timestamp ("now", "1 min ago", "5 min
  ago", "1 hr ago").
- Click an item → activates the originating project (existing
  resolver hook). The list filters all items for that project out.
- Bottom row: "Mark all read" link (clears the list without
  switching). Hidden when list is empty.
- Empty state: "No notifications" centered, muted icon + text.

### Hover-pause on toasts

- `onMouseEnter` on a toast card → call `pauseToastDismiss(id)`
  (clear the `setTimeout`).
- `onMouseLeave` → call `resumeToastDismiss(id)` (schedule a fresh
  timer at the full original duration for the kind).
- The X-button click and the body click already short-circuit
  through `dismissToast` / `activateAndDismiss`; no change needed.

### Success Criteria

- [ ] Toast fires on a focused window for any of the three ways an
      alert can land (`stop` from JSONL, `permission_request` from
      OSC, OS-banner equivalent when blurred).
- [ ] Each fired alert appears in the bell popover with project +
      title + body + relative timestamp.
- [ ] Bell badge counts unread items, capped at "9+".
- [ ] Click on a bell item activates the project AND removes all
      items for that project from the list.
- [ ] Click on a toast card (already activates) AND removes all
      items for that project from the list (consistency).
- [ ] X-dismissed toast does NOT remove items from the bell.
- [ ] "Mark all read" empties the list without changing active
      project.
- [ ] Hovering a toast pauses its auto-dismiss; mouse-leave starts
      a fresh full-duration timer.
- [ ] Activating a project via the sidebar avatar (current path)
      also clears its items from the bell.
- [ ] List capped at 50 items in memory; oldest dropped silently.
- [ ] Restart of the app starts the bell empty (no localStorage
      persistence).

### Non-goals

- Cross-session persistence — explicitly rejected, see issue.
- Read-but-still-visible items / history view — would dilute the
  signal.
- Inline action buttons on bell items.
- Per-project filtering inside the popover.

## How

### Data model — `src/context/notifications.tsx`

New types:

```ts
export type UnreadItem = {
  id: number;            // monotonic, distinct from toast ids
  kind: ToastKind;
  projectPath: string;
  title: string;
  body: string;
  createdAt: number;     // Date.now() at enqueue
};
```

New signals + module-scoped state:

```ts
const [unreadItems, setUnreadItems] = createSignal<readonly UnreadItem[]>([]);
const MAX_UNREAD_ITEMS = 50;
let nextItemId = 1;
```

New actions:

```ts
function enqueueUnreadItem(seed: Omit<UnreadItem, "id" | "createdAt">) {
  const item: UnreadItem = { ...seed, id: nextItemId++, createdAt: Date.now() };
  setUnreadItems((prev) => {
    const next = [item, ...prev];
    return next.length > MAX_UNREAD_ITEMS ? next.slice(0, MAX_UNREAD_ITEMS) : next;
  });
}

function clearProjectItems(projectPath: string) {
  setUnreadItems((prev) => prev.filter((x) => x.projectPath !== projectPath));
}

function clearAllItems() {
  setUnreadItems([]);
}
```

`alertProject` (existing) calls `enqueueUnreadItem` unconditionally
(both focused and blurred paths populate the bell — the bell is the
catch-all). The toast queue branch stays gated by `focused()`.

`activateAndDismiss(toast)` (existing) — extend to also call
`clearProjectItems(toast.projectPath)`.

`markRead(projectPath)` (existing, called from `App.tsx` on project
activation) — extend to also call `clearProjectItems(projectPath)`.
This way the sidebar-avatar click path keeps working.

Hover-pause:

```ts
function pauseToastDismiss(id: number) {
  const t = dismissTimers.get(id);
  if (t) {
    clearTimeout(t);
    dismissTimers.delete(id);
  }
}

function resumeToastDismiss(id: number) {
  const toast = toasts().find((t) => t.id === id);
  if (!toast || dismissTimers.has(id)) return;
  const handle = setTimeout(() => dismissToast(id), autoDismissMs(toast.kind));
  dismissTimers.set(id, handle);
}
```

### Component — `src/components/notification-bell.tsx` (new)

```tsx
export function NotificationBell() {
  const notifications = useNotifications();
  const [open, setOpen] = createSignal(false);
  const count = createMemo(() => notifications.unreadItems().length);
  // outside-click + Escape close: same pattern as OpenInDropdown.
  return (
    <div class="relative">
      <button
        type="button"
        class="..."
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        title="Notifications"
      >
        <Bell size={14} />
        <Show when={count() > 0}>
          <span class="absolute -top-0.5 -right-0.5 ...">
            {count() > 9 ? "9+" : count()}
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <NotificationPopover onClose={() => setOpen(false)} />
      </Show>
    </div>
  );
}
```

`<NotificationPopover>` renders the list (`<For each={items()}>`)
with `<NotificationItem>` rows, plus the Mark-all-read row at the
bottom. Items use the same project-initial avatar shape as the
sidebar (compute from project basename) and the same neutral-
backed accent for `permission` kind that the toasts use.

Relative time helper (`src/lib/relative-time.ts`, ~15 LoC) returns
"now", "1 min ago", "N min ago", "1 hr ago", "N hr ago" — capped
at the unit, no "just now" / "yesterday" rabbit hole.

### Mount point — `src/components/titlebar.tsx`

The titlebar already has a right-side button cluster. Insert
`<NotificationBell />` just before the existing OpenInDropdown +
shell-panel toggle area.

### Toast hover-pause — `src/components/notification-toast.tsx`

```tsx
<div
  ...
  onMouseEnter={() => notifications.pauseToastDismiss(props.toast.id)}
  onMouseLeave={() => notifications.resumeToastDismiss(props.toast.id)}
>
```

That's the entire change on the toast component.

## Risks

- **Outside-click handling collisions.** The popover competes with
  the existing context-menu / open-in-dropdown patterns for
  document-level click listeners. We follow the same pattern those
  use (a single `mousedown` listener on `document` that checks if
  the click is inside the popover ref) — established and known
  working.
- **Item ID overflow.** `nextItemId` is a regular JS number; even
  at 1000 alerts/day this lasts ~25,000 years. Safe.
- **Pause-on-hover edge case.** If the toast is removed (e.g. via
  the auto-dismiss firing exactly as the user hovers), `pauseToastDismiss`
  is a no-op. If the user hovers, we pause; if the project is
  activated by another path while hovering, the toast disappears
  and `dismissTimers` already has no entry. No leaks.

## Known limitations

- No way to dismiss a single bell item without activating the
  project. Could add a per-row X if it comes up; for now "click to
  attend" + "Mark all read" cover the use cases.
- Relative timestamps don't auto-refresh while the popover is
  open. If the user keeps the popover open for 5+ minutes the
  "1 min ago" stays stale until they reopen. Cheap to fix later
  with a 30s tick; not worth the wiring for v1.

## Out of scope (track separately)

- Persistent history (localStorage / SQLite).
- Inline action buttons on `permission_request` items
  (depends on [#25](https://github.com/willywg/klaudio-panels/issues/25)).
- Per-project filter inside the popover.
- Auto-refresh of relative timestamps while popover is open.
