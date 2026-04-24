# PRP 010: Resizable Sessions/Files sidebar with per-project width

> **Version:** 1.0
> **Created:** 2026-04-24
> **Status:** Draft
> **Tracks:** [#3](https://github.com/willywg/klaudio-panels/issues/3)

---

## Goal

The Sessions/Files sidebar becomes drag-resizable on its right edge,
clamped between 200px and 50% of window width. The chosen width is
persisted **per project** in `localStorage` (key
`sidebarWidth:<projectPath>`), mirroring the diff panel's
per-project persistence. Cmd+B collapse behavior is unchanged; on
expand, the last remembered width for the current project is
restored.

## Why

- Today the sidebar is hardcoded to `w-[280px]`. Monorepos with long
  session titles and deep trees feel cramped; flat projects waste
  horizontal real estate.
- Per-project (not global) width mirrors the existing
  `sidebarTab:<projectPath>` and `diffPanelWidth:<projectPath>`
  patterns — each project already carries its own UX state, width
  slots in naturally.
- The underlying drag component (`SplitDivider`) already exists and
  is reusable with a tiny extension. This is additive, not new
  surface area.

## What

### Success Criteria

- [ ] A 4px vertical handle on the sidebar's right edge shows a
      `col-resize` cursor and a hover highlight identical to the
      diff panel's.
- [ ] Dragging resizes the sidebar live, clamped to `[200, 0.5 *
      windowWidth]`.
- [ ] Width persists to `localStorage["sidebarWidth:<projectPath>"]`
      on pointer-up (not on every move).
- [ ] Opening project A at 220px and project B at 360px keeps each
      at its own width when switching back and forth.
- [ ] Cmd+B collapses the sidebar to 0; pressing Cmd+B again
      restores the per-project width (not the 280px default unless
      no stored width exists).
- [ ] No regression to the diff panel's existing drag behavior.

### Non-goals

- Dragging the sidebar's left edge (no left-docked analog exists).
- A "snap back to default" affordance (defer; user can just drag).
- Animating width changes on restore (instant is fine; matches
  diff panel today).

---

## All Needed Context

### Project-level references (always relevant)

```yaml
- file: PROJECT.md
  why: Blueprint; per-project state convention
- file: CLAUDE.md
  why: Decision #12 — sidebar is OpenCode-style collapsible aside.
       Widening that from a fixed 280 to a range [200, 50%] doesn't
       break the rule; just makes it user-driven.
```

### Feature-specific references

```yaml
- file: src/components/diff-panel/split-pane.tsx
  why: The <SplitDivider> we will extend. Currently hardcodes
       right-edge math (rect.right - e.clientX). Add an `edge` prop.

- file: src/context/diff-panel.tsx
  why: Pattern for per-project width. See `widthFor`, `setWidth`,
       the Map + widthBump signal, and the DEFAULT_WIDTH constant.
  lines: 15, 70-71, 211-223

- file: src/lib/diff-panel-prefs.ts
  why: Direct template for sidebar-prefs width helpers.
  lines: 21-38

- file: src/App.tsx
  why: Where <DiffPanel> + <SplitDivider> are mounted today.
       Sidebar mount site is inside <SidebarPanel> via
       SidebarProvider — we add the divider as a sibling of
       <aside> so the drag anchor is in the same flex row.
  lines: 740-758 (diff panel mount — mirror this)
```

### Current repo state (relevant files)

```
src/
├── App.tsx                              # mount wiring
├── context/
│   └── sidebar.tsx                      # add widthFor/setWidth
├── lib/
│   └── sidebar-prefs.ts                 # add width helpers
└── components/
    ├── sidebar-panel.tsx                # 280 → dynamic width
    └── diff-panel/
        └── split-pane.tsx               # add `edge` prop
```

### Desired changes

```
src/
├── context/
│   └── sidebar.tsx                      [MODIFY — +widthFor/+setWidth]
├── lib/
│   └── sidebar-prefs.ts                 [MODIFY — +getSidebarWidth/
│                                                 +setSidebarWidth]
└── components/
    ├── sidebar-panel.tsx                [MODIFY — dynamic width style]
    ├── diff-panel/
    │   └── split-pane.tsx               [MODIFY — +edge prop]
    └── — [no new component files] —
```

### Known gotchas

```
- SplitDivider's current clamp naming: `minLeft` / `minRight` is
  directional and would get confusing with the new edge prop.
  Rename internally to `minSelf` / `minOther` (self = the panel the
  divider resizes; other = the panel it shares a row with). Only
  one external consumer today (App.tsx for diff panel), so the
  rename is cheap.

- The sidebar mounts inside <aside>. Its parent is the flex row
  that also holds <section> (terminal area) and the diff panel.
  `getParentRect` must return THAT row, not the aside. Use the
  existing `splitContainerRef` that App.tsx already owns for the
  diff panel — reuse the same ref.

- Cmd+B collapse must not trigger a width write. Width persists
  only on pointerup. Collapse is a separate concern (already
  working).

- On mount, if no stored width exists, default to 280 (current
  hardcoded value) so existing users see zero visual change.
```

---

## Implementation Blueprint

### Data / types

```typescript
// src/lib/sidebar-prefs.ts — additions
const WIDTH_PREFIX = "sidebarWidth:";
export function getSidebarWidth(projectPath: string): number | null
export function setSidebarWidth(projectPath: string, px: number): void
```

```typescript
// src/context/sidebar.tsx — additions
const DEFAULT_SIDEBAR_WIDTH = 280;
// same Map + bump pattern as diff-panel.tsx
function widthFor(projectPath: string): number
function setWidth(projectPath: string, px: number): void
```

```typescript
// src/components/diff-panel/split-pane.tsx — additions
type Props = {
  edge?: "left" | "right";   // default "right" (back-compat)
  width: number;
  onResize: (next: number) => void;
  onResizeEnd: (final: number) => void;
  getParentRect: () => DOMRect;
  minSelf?: number;           // renamed from minRight
  minOther?: number;          // renamed from minLeft
}
```

### Tasks (in execution order)

```yaml
Task 1: sidebar-prefs.ts — add width helpers
  - MIRROR: diff-panel-prefs.ts
  - KEY: "sidebarWidth:" prefix

Task 2: sidebar.tsx context — expose widthFor/setWidth
  - MIRROR: diff-panel.tsx context (Map + widthBump signal)
  - DEFAULT: 280

Task 3: split-pane.tsx — extract edge-aware math
  - ADD: `edge` prop ("left" | "right"), default "right"
  - RENAME: minLeft/minRight → minOther/minSelf
  - FLIP: if edge="left", proposed = e.clientX - rect.left;
          else proposed = rect.right - e.clientX
  - UPDATE: sole caller (App.tsx line ~743) to use new prop names

Task 4: sidebar-panel.tsx — dynamic width
  - REMOVE: w-[280px] from <aside>
  - ADD: style={{ width: `${sidebar.widthFor(projectPath)}px` }}

Task 5: App.tsx — mount sidebar-edge SplitDivider
  - INSERT: <SplitDivider edge="left" ...> as immediate sibling
            after <SidebarPanel> and before the main flex row,
            only when !sidebar.collapsed()
  - WIRE: width=sidebar.widthFor(p), onResize=setWidth,
          getParentRect=splitContainerRef.getBoundingClientRect
  - MIN: minSelf=200, minOther=360 (same terminal floor the diff
         panel uses)
```

### Pseudocode (critical bits)

```tsx
// split-pane.tsx — edge-aware math
function onPointerMove(e: PointerEvent) {
  if (!dragging()) return;
  const rect = props.getParentRect();
  const minSelf = props.minSelf ?? 300;
  const minOther = props.minOther ?? 360;
  const proposed = props.edge === "left"
    ? e.clientX - rect.left
    : rect.right - e.clientX;
  const maxSelf = rect.width - minOther;
  const clamped = Math.max(minSelf, Math.min(proposed, maxSelf));
  props.onResize(clamped);
}
```

```tsx
// App.tsx — sidebar divider placement (sketch)
<Show when={!sidebar.collapsed() && activeProjectPath()}>
  {(p) => (
    <SplitDivider
      edge="left"
      width={sidebar.widthFor(p())}
      onResize={(w) => sidebar.setWidth(p(), w)}
      onResizeEnd={(w) => sidebar.setWidth(p(), w)}
      getParentRect={() => splitContainerRef.getBoundingClientRect()}
      minSelf={200}
      minOther={360}
    />
  )}
</Show>
```

---

## Validation Loop

### Level 1: static checks

```bash
bun run typecheck
cd src-tauri && cargo check          # no-op — no Rust changes
cd src-tauri && cargo clippy -- -D warnings
```

### Level 2: manual integration

```bash
bun tauri dev
```

Steps:
1. Open project A. Drag sidebar right edge to ~220px. Release.
2. Reload app. Sidebar should still be at 220px.
3. Open project B. Should open at 280 (default, no stored width).
   Drag to 360px, release. Reload. B at 360, A still at 220.
4. Collapse with Cmd+B. Expand with Cmd+B. Width restored.
5. Try to drag below 200 and above ~50% window — should clamp.
6. Open diff panel (Cmd+Shift+D or whatever shortcut). Drag its
   divider. Still works. No regression.
7. Resize window smaller. (Window-resize-responsiveness is issue
   #4, not in this PRP — the clamp will cover the clamping but
   won't auto-shrink to stay proportional. That's fine here.)

---

## Final Checklist

- [ ] `bun run typecheck` clean
- [ ] `cargo check` + `cargo clippy` clean (no Rust changes expected)
- [ ] Manual flow above runs without regressions
- [ ] Sidebar width persists across app restart
- [ ] Diff panel width still persists and drags correctly (no
      regression from the SplitDivider refactor)
- [ ] Cmd+B collapse/expand preserves per-project width

---

## Anti-Patterns to Avoid

- ❌ Don't write width on every pointermove (localStorage spam).
  Only on pointerup.
- ❌ Don't create a second DragHandle component — extend the existing
  `SplitDivider`. One source of truth for drag math.
- ❌ Don't make width global. Each project has its own UX state
  already (active tab, diff width); width joins that set.
- ❌ Don't gate behind a flag. It's additive — nothing to toggle off.

---

## Notes

- Related issue #4 (diff panel / center panel not proportional on
  window resize) is intentionally out of scope. Both panels will
  likely share a follow-up "scale-on-window-resize" rule that can
  live in a single place; doing it here would double the PRP's
  surface. After this PRP merges, #4 becomes the natural next
  piece.
- No Rust changes. Pure frontend.
