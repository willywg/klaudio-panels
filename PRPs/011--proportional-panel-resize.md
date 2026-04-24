# PRP 011: Proportional panel resize on window shrink

> **Version:** 1.0
> **Created:** 2026-04-24
> **Status:** Draft
> **Tracks:** [#4](https://github.com/willywg/klaudio-panels/issues/4)
> **Builds on:** [PRP 010](./010--resizable-sidebar.md)

---

## Goal

When the app window is resized smaller, the side-docked panels
(sidebar from PRP 010, diff panel) stop holding their absolute
pixel width and instead clamp to the new parent-row width while
preserving the user's stored preference. When the window grows
back, the displayed widths return to the stored values. The user's
choice is never silently overwritten.

## Why

- Reported in [#4](https://github.com/willywg/klaudio-panels/issues/4): on a narrower window the diff panel
  keeps its full ~640px and the center terminal is squeezed to the
  point of being unusable. PRP 010 just added the same issue for
  the sidebar.
- The current `SplitDivider` clamps only during drag. Once the
  drag ends, the stored width can exceed what the current window
  allows if the window shrinks later.
- Users expect OS-native window-resize behavior: panels give back
  space proportionally until they hit a minimum, then the center
  starts to shrink. We do the first half but not the second.

## What

A read-side clamp: each panel's rendered width is
`min(stored, maxEffective)`, where `maxEffective` is derived from
the current parent-row width. The stored value (in `localStorage`)
is never mutated by window resizes — only by explicit user drags.

### Success Criteria

- [ ] Open a project with both sidebar (at e.g. 360px) and diff
      panel (at 640px). Shrink the window. The panels give up
      width proportionally; the center terminal keeps ≥360px until
      both panels hit their mins.
- [ ] Grow the window back. The panels restore to their stored
      widths (360 / 640) without the user doing anything.
- [ ] `localStorage["sidebarWidth:<project>"]` and
      `["diffPanelWidth:<project>"]` are unchanged across the
      shrink/grow cycle.
- [ ] Dragging a panel in a narrow window works: the drag clamp
      (already in `SplitDivider`) respects the same maxEffective.
- [ ] When only one panel is open, it alone gets the remaining
      space up to its 50% cap.
- [ ] Combined panel widths can never push the center below its
      minimum (360px).

### Non-goals

- Animating the shrink (instant is fine; OS native panels are
  instant).
- Proportional *growth* beyond stored values (that would require a
  "fill available space" mode — out of scope).

### Additional rules (confirmed with maintainer)

1. **Absolute caps per panel**, independent of `maxFraction`:
   - `SIDEBAR_MAX = 500`
   - `DIFF_MAX = 800`
   On ultrawide monitors this forces the leftover space into the
   center column (which is the user's priority).

2. **Non-destructive auto-hide of the diff panel** when the window
   is too narrow to host both panels + a usable center. Threshold:
   `rowWidth < SIDEBAR_MIN + DIFF_MIN + CENTER_MIN` (= 860 with
   sidebar visible) or `< DIFF_MIN + CENTER_MIN` (= 660 with
   sidebar collapsed). When triggered, the diff panel is not
   rendered, but `diffPanelOpen:<path>` in localStorage is NOT
   touched — widening the window makes it reappear automatically.

3. **No debounce on `ResizeObserver`.** The browser already
   schedules RO callbacks against rAF.

---

## All Needed Context

### Project-level references

```yaml
- file: PRPs/010--resizable-sidebar.md
  why: Immediately-preceding PRP. Establishes per-project width +
       SplitDivider.edge + the 200/360 clamp values we're reusing.
- file: CLAUDE.md
  why: Rules #7 + #12 on panel layout. Nothing new contradicted.
```

### Feature-specific references

```yaml
- file: src/components/diff-panel/split-pane.tsx
  why: Drag-time clamp already uses `rect.width - minOther` plus
       the `maxFraction` cap from PRP 010. We extend that math to
       the render path.

- file: src/context/sidebar.tsx
  why: Pattern to expose effective-width read.
  lines: widthFor ~end of file

- file: src/context/diff-panel.tsx
  why: Same pattern, different context.
  lines: 211-223 (widthFor/setWidth)

- file: src/App.tsx
  why: Central mount point. The parent row (`sidebarRowRef`) is
       where we attach a ResizeObserver and derive rowWidth.
  lines: 661 (sidebarRowRef), 693 (splitContainerRef), 697-710
         (sidebar SplitDivider), 762-780 (diff SplitDivider)
```

### Desired changes (files to modify)

```
src/
├── lib/
│   └── panel-layout.ts       [NEW — pure helpers + shared constants,
│                               computes sidebar + diff effective widths
│                               TOGETHER so the center is guaranteed
│                               its 360px floor]
├── components/
│   ├── sidebar-panel.tsx     [accept width via prop instead of
│   │                           reading context directly]
│   └── diff-panel/
│       └── split-pane.tsx    [no change — already handles
│                               maxFraction/minOther]
└── App.tsx                   [+ResizeObserver on sidebarRowRef,
                               +rowWidth signal, createMemo wrapping
                               computePanelLayout, wire effective
                               widths into renders + dividers]
```

### Why a joint helper (not per-context methods)

Initial draft put `effectiveWidthFor` on each context. That breaks
when both panels are at their stored maxima: each panel clamps to
`rowWidth * 0.5` independently → combined can consume all of
`rowWidth`, leaving the center below its 360px floor.

Joint computation is the only way to correctly protect the center
when both panels are visible. The pure helper lives in
`src/lib/panel-layout.ts` — contexts stay focused on storage.

### Known gotchas

```
- Don't mutate stored values on window resize. The user's drag
  intent is sticky; the clamp is purely a presentation layer.

- ResizeObserver fires synchronously after layout; wrap the
  setSignal in a microtask or use untrack-safe update to avoid
  infinite loops if any child's size depends on rowWidth.

- When both panels are open at their stored maxima on a narrow
  window, SUM(stored) can exceed rowWidth - minCenter.
  Independent per-panel clamping leaves the center squeezed.
  Fix: each panel's maxEffective accounts for the OTHER panel's
  minimum:
      sidebarMaxEff = min(stored, 0.5*row, row - 360 - diffMin)
      diffMaxEff    = min(stored, 0.5*row, row - 360 - sidebarMin)
  At narrow widths both hit their own minimums and combined layout
  still fits.

- `SplitDivider`'s drag-time math already reads rowWidth from
  `getParentRect()` on every pointermove. If we pass the SAME
  `minOther` that includes the other panel's min, the drag is
  consistent with the render.

- The diff panel's current SplitDivider call site does NOT pass
  `minOther` — it uses the default 360. That default needs to
  grow to 360 + (sidebarOpen ? 200 : 0). Likewise sidebar's
  call site.
```

---

## Implementation Blueprint

### Data flow

```
                    ┌────────────────────────────┐
                    │ ResizeObserver(sidebarRow) │
                    └─────────────┬──────────────┘
                                  │
                              setRowWidth
                                  │
              ┌───────────────────┴──────────────────┐
              │                                      │
       sidebar.effectiveWidth            diffPanel.effectiveWidth
       (projectPath, rowWidth,             (projectPath, rowWidth,
        otherPanelMinSpace)                 otherPanelMinSpace)
              │                                      │
          <aside>                              <div><DiffPanel/>
          style={width}                        style={width}
```

### Types / constants

```typescript
// src/lib/panel-layout.ts — single source of truth for dimensions
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 500;
export const DIFF_MIN   = 300;
export const DIFF_MAX   = 800;
export const CENTER_MIN = 360;

export type PanelLayoutInput = {
  rowWidth: number;
  sidebarVisible: boolean;
  diffOpen: boolean;
  sidebarStored: number;
  diffStored: number;
};
export type PanelLayout = {
  sidebarEff: number;
  diffEff: number;
  diffVisible: boolean; // auto-hide flag (see below)
};

export function computePanelLayout(input: PanelLayoutInput): PanelLayout
```

### Algorithm (inside `computePanelLayout`)

```
1. If rowWidth <= 0 (pre-measure tick): return stored widths as-is.

2. diffFits = diffOpen && rowWidth >=
     DIFF_MIN + CENTER_MIN + (sidebarVisible ? SIDEBAR_MIN : 0)
   — This is the non-destructive auto-hide test.

3. Only sidebar visible: clamp to [SIDEBAR_MIN, min(SIDEBAR_MAX,
   rowWidth - CENTER_MIN)].

4. Only diff visible: symmetric with DIFF_MIN / DIFF_MAX.

5. Both visible:
   sidebarPref = min(sidebarStored, SIDEBAR_MAX, rowWidth * 0.5)
   diffPref    = min(diffStored,    DIFF_MAX,    rowWidth * 0.5)
   available   = rowWidth - CENTER_MIN
   if sidebarPref + diffPref <= available:
     return preferred widths (clamped to own min)
   else:
     ratio = available / (sidebarPref + diffPref)
     sidebarEff = max(SIDEBAR_MIN, sidebarPref * ratio)
     diffEff    = max(DIFF_MIN,    diffPref    * ratio)
```

This guarantees: center ≥ CENTER_MIN whenever diff is visible
(auto-hide fires before the algorithm would have to violate it).

### Tasks (in order)

```yaml
Task 1: src/lib/panel-layout.ts — pure helper + constants
  - EXPORT: SIDEBAR_MIN, SIDEBAR_MAX, DIFF_MIN, DIFF_MAX, CENTER_MIN
  - EXPORT: computePanelLayout(input) per the algorithm above

Task 2: sidebar-panel.tsx — accept width via prop
  - ADD: `width: number` to Props
  - REPLACE: `sidebar.widthFor(props.projectPath)` → `props.width`
  - KEEP: collapse Show wrapper as-is

Task 3: App.tsx — ResizeObserver + createMemo(panelLayout)
  - SIGNAL: `[rowWidth, setRowWidth] = createSignal(0)`
  - ON MOUNT: ResizeObserver(sidebarRowRef) → setRowWidth
  - MEMO: `panelLayout = createMemo(() => computePanelLayout({...}))`
    reads from sidebar, diffPanel, rowWidth signals

Task 4: App.tsx — wire renders to panelLayout()
  - <SidebarPanel width={panelLayout().sidebarEff} />
  - Sidebar SplitDivider: width, minOther (CENTER_MIN + DIFF_MIN if
    diff visible else CENTER_MIN), minSelf=SIDEBAR_MIN
  - Diff <Show when={panelLayout().diffVisible}> so auto-hide works
  - Diff SplitDivider + wrapper <div>: width = panelLayout().diffEff
```

### Pseudocode — App.tsx wiring

```tsx
const [rowWidth, setRowWidth] = createSignal(0);

onMount(() => {
  const ro = new ResizeObserver((entries) => {
    const e = entries[0];
    if (e) setRowWidth(e.contentRect.width);
  });
  ro.observe(sidebarRowRef);
  onCleanup(() => ro.disconnect());
});

const sidebarVisible = () =>
  !sidebar.collapsed() && activeProjectPath() !== null;
const diffVisible = () => {
  const p = activeProjectPath();
  return p !== null && diffPanel.isOpen(p);
};

const sidebarEffective = (p: string) =>
  sidebar.effectiveWidthFor(
    p,
    rowWidth(),
    diffVisible() ? DIFF_MIN : 0,
  );
const diffEffective = (p: string) =>
  diffPanel.effectiveWidthFor(
    p,
    rowWidth(),
    sidebarVisible() ? SIDEBAR_MIN : 0,
  );

// Mount:
<SidebarPanel projectPath={p()} width={sidebarEffective(p())} ... />
<SplitDivider
  edge="left"
  width={sidebarEffective(p())}
  minSelf={SIDEBAR_MIN}
  minOther={CENTER_MIN + (diffVisible() ? DIFF_MIN : 0)}
  maxFraction={0.5}
  ...
/>
...
<div style={{ width: `${diffEffective(p())}px` }}>
  <DiffPanel projectPath={p()} />
</div>
<SplitDivider
  width={diffEffective(p())}
  minSelf={DIFF_MIN}
  minOther={CENTER_MIN + (sidebarVisible() ? SIDEBAR_MIN : 0)}
  ...
/>
```

---

## Validation Loop

### Level 1: static checks

```bash
bun run typecheck
cd src-tauri && cargo check           # no Rust touched
cd src-tauri && cargo clippy -- -D warnings
```

### Level 2: manual integration

```bash
bun tauri dev
```

Steps:
1. Open a project. Set sidebar to 360px, open diff panel at 640px.
2. Shrink the window from, say, 1400 → 900 → 720 → 600.
3. At each step: sidebar + center + diff visually stay
   well-proportioned; center never drops below ~360px until both
   panels hit their mins (200 / 300).
4. Grow the window back to 1400. Sidebar and diff return to 360 /
   640.
5. Check `localStorage` in devtools:
   `sidebarWidth:<path>` still 360; `diffPanelWidth:<path>` still
   640. Never mutated by the resize cycle.
6. In a narrow window, grab the sidebar's drag handle and try to
   widen it. The drag clamp matches the render clamp — can't
   drag into the diff panel's min zone.
7. Close the diff panel; the sidebar can expand to 50% of the
   (larger) available row.

---

## Final Checklist

- [ ] Frontend typecheck + cargo check + clippy clean
- [ ] Proportional behavior verified by eye across a 1400→600
      resize sweep
- [ ] Stored `localStorage` values unchanged by window resize
- [ ] Drag-time clamp still consistent (no "drag shows one width,
      release snaps to another")
- [ ] Regression: opening/closing diff panel still works; Cmd+B
      still works; per-project width from PRP 010 still persists

---

## Anti-Patterns to Avoid

- ❌ Don't mutate stored width on window resize. Stored = user's
  drag intent, effective = what we show.
- ❌ Don't `setTimeout` / debounce the ResizeObserver. The user's
  resize gesture is fluid; stutter here is obvious.
- ❌ Don't hand-roll a `window.addEventListener("resize", ...)` —
  ResizeObserver on the parent row is the right primitive.
- ❌ Don't let sidebar-panel.tsx import diff-panel state. Width is
  computed at the mount site (App.tsx), which is the only place
  that knows about both panels.

---

## Notes

- The `CENTER_MIN = 360` constant is also implied in the diff
  panel's current SplitDivider default. Worth promoting to a
  single shared constant later — but not in this PRP (YAGNI on
  the refactor; value is identical in all call sites today).
- Follow-up idea (not this PRP): also honor an absolute cap
  (e.g. 600px hard max) so wide monitors don't get a 1200px
  sidebar. Defer until someone asks.
