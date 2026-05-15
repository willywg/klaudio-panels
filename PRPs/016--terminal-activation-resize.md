# PRP 016: Single-fit terminal activation (kill the stagger storm)

> **Version:** 1.0
> **Created:** 2026-05-03
> **Status:** Draft
> **Tracks:** [#38](https://github.com/willywg/klaudio-panels/issues/38)
> **Regresses against:** [`e4bccd1`](https://github.com/willywg/klaudio-panels/commit/e4bccd1) — "stagger fit on project/tab activation (#8)" closed [#7](https://github.com/willywg/klaudio-panels/issues/7)

---

## Goal

Stop disrupting Claude's alt-screen render when the user switches
projects. Replace the 3-stage staggered-fit on activation with a
**single late fit** + a **single immediate refresh**, so Claude
receives at most one SIGWINCH per activation.

## Why

`src/components/terminal-view.tsx:293-321` schedules three fits on
activation:

```
rAF        → safeFit() + term.refresh() + term.focus()
+180ms     → safeFit()
+500ms     → safeFit() + term.refresh()
```

Each `safeFit()` calls `fit.fit()`. Looking at the FitAddon source
(`node_modules/@xterm/addon-fit/src/FitAddon.ts:35-49`):

```ts
public fit(): void {
  const dims = this.proposeDimensions();
  if (!dims || !this._terminal || ...) return;
  if (this._terminal.rows !== dims.rows || this._terminal.cols !== dims.cols) {
    core._renderService.clear();
    this._terminal.resize(dims.cols, dims.rows);
  }
}
```

It already short-circuits no-op fits. So three fits on the same
settled layout are harmless — but on a project switch, the layout is
**not** settled when rAF fires. Per-project sidebar width recomputes
([#5](https://github.com/willywg/klaudio-panels/pull/5)), the
panelLayout memo redistributes
([#6](https://github.com/willywg/klaudio-panels/pull/6)), and the
diff panel may auto-show or auto-hide. Each fit lands at a different
intermediate size, each one passes the `cols/rows changed` guard,
each one calls `term.resize()` → `onResize` → `pty_resize` →
SIGWINCH → Claude redraws the alt-screen.

Three SIGWINCHes within 500ms is too many. Symptoms reported in #38:

- **Scroll drifts up.** xterm reflows wrapped lines on each resize;
  intermediate `viewportY`/`baseY` math gets stuck at a non-bottom
  position by the time the user sees the panel.
- **Welcome banner re-appears mid-stream.** When alt-screen content
  is being rewritten by Claude in response to a resize and xterm is
  asked to repaint the viewport mid-flight, the previous-screen
  scrollback (which contains Claude's startup banner) can leak
  through visually.

## What

### Activation effect — new shape

```
on active=true:
  immediate  → term.refresh(0, term.rows-1)   // one repaint for WebGL
              term.focus()                     // claim keyboard
  +250ms     → safeFit()                       // one fit at settled size
```

Cancellation on `onCleanup` keeps the pending fit from firing on a
deactivated tab.

### Why these knobs

- **One refresh, immediate.** The WebGL renderer stops painting while
  the canvas is `visibility: hidden` — that part of the original
  comment chain holds. We need to repaint *whatever's in xterm's
  buffer right now*, regardless of whether dimensions change. This
  covers the "fit is a no-op so no SIGWINCH so no auto-repaint" case
  flagged in the existing comment (`terminal-view.tsx:262-275`).

- **One fit, late.** The original "panel comes back one row short"
  bug from #7 happened because rAF was too early — the layout hadn't
  settled. 250ms is well past the layout settling point we observed
  via the 180ms / 500ms stages, but only triggers a single resize
  when (and only when) dimensions actually changed.

- **No second refresh.** After `fit.fit()` runs and dimensions
  changed, two things happen:
  1. FitAddon clears the renderer (`core._renderService.clear()`).
  2. `term.resize(cols, rows)` fires `onResize` → SIGWINCH → Claude
     re-paints. Claude's bytes arrive on the data channel and xterm
     renders them incrementally as they land. No manual refresh
     needed.

  When dimensions *didn't* change, the immediate refresh already
  covered the WebGL re-show case.

### Success Criteria

- [ ] Switching between 3+ projects in quick succession (~10s) no
      longer leaves the alt-screen scrolled up or shows the welcome
      banner mid-stream.
- [ ] Tab switches *within* the same project remain visually
      identical to today (no row clipping).
- [ ] Project switch from home → project still arrives at the
      correct cols/rows on the first paint (no row clipping —
      regression check against #7).
- [ ] Window resize during active project still re-fits correctly
      (independent code path: `onWinResize` in `terminal-view.tsx:261`,
      not touched by this PRP).
- [ ] No new TypeScript / clippy warnings.

### Non-goals

- Removing the WebGL addon or switching to canvas — out of scope and
  would re-trigger separate performance issues.
- Changing the activation effect for `editor-pty-view.tsx` (Neovim
  embed). That view doesn't run Claude, the bug doesn't reproduce
  there, and its own staggered-fit pattern was added for the same
  one-row-short reason. **Will inspect, but not modify unless
  evidence points there.**
- Any backend (Rust) changes. The fix is entirely frontend.

## How

### Step 1 — replace the activation effect in `terminal-view.tsx`

Current shape (lines 293-321):

```tsx
createEffect(() => {
  if (!props.active) return;
  const rafId = requestAnimationFrame(() => {
    safeFit();
    try { if (term) term.refresh(0, term.rows - 1); term?.focus(); }
    catch { /* ignore */ }
  });
  const t180 = window.setTimeout(() => safeFit(), 180);
  const t500 = window.setTimeout(() => {
    safeFit();
    try { if (term) term.refresh(0, term.rows - 1); }
    catch { /* ignore */ }
  }, 500);
  onCleanup(() => {
    cancelAnimationFrame(rafId);
    window.clearTimeout(t180);
    window.clearTimeout(t500);
  });
});
```

Replacement:

```tsx
createEffect(() => {
  if (!props.active) return;

  // 1) Immediate repaint. WebGL stops painting while the canvas is
  //    `visibility: hidden`; without this, the panel stays blank
  //    until something else triggers a redraw. Decoupled from fit
  //    because fit may legitimately be a no-op (dimensions match).
  try {
    if (term) term.refresh(0, term.rows - 1);
    term?.focus();
  } catch {
    // ignore — refresh failures shouldn't block the activation flow.
  }

  // 2) Single late fit. Project switch reflows the outer layout
  //    (per-project sidebar width, panelLayout memo, diff visibility)
  //    asynchronously; an immediate fit caches an intermediate width.
  //    The previous staggered approach fired three fits at rAF +
  //    180ms + 500ms — when dimensions changed across the stages,
  //    each one sent a SIGWINCH and Claude re-painted the alt-screen,
  //    drifting xterm's buffer state. One late fit avoids the storm.
  const fitTimer = window.setTimeout(() => safeFit(), 250);

  onCleanup(() => {
    window.clearTimeout(fitTimer);
  });
});
```

### Step 2 — leave window-resize and onMount paths untouched

- `onMount` (lines 130-139) keeps its existing `document.fonts.ready`
  + rAF + 180ms + 500ms ladder. That path runs once per terminal
  instance, not per activation, so the SIGWINCH storm doesn't
  manifest the same way (no Claude content to disturb yet — fresh
  xterm, fresh PTY).
- `onWinResize` (lines 261-277) handles real window-size changes
  driven by the OS; preserve as-is. The race it guards against
  (mid-layout cols=1 cache from a flex reflow) is real and unrelated.

### Step 3 — inspect `editor-pty-view.tsx`

Confirm the same staggered-fit pattern exists. If it does:

- Check whether the bug repros there too (open Neovim, switch
  projects). If not, leave it alone — the cost of changing it without
  a verified bug isn't worth the regression risk.
- If it does repro, apply the same change in a follow-up commit
  inside this PR.

## Risks

- **Regression of #7 ("panel comes back one row short").** This is
  the chief concern. Mitigation: 250ms is past the 180ms point that
  was working in the staggered version; if dimensions are still
  wrong at 250ms, the original fix was already racy and we should
  consider `requestIdleCallback` with a generous fallback.
  Verification: deliberate project-switch flow with at least one
  project that has a different sidebar width than the previous one,
  inspecting that the bottom row isn't clipped.
- **WebGL-blank-on-activation if `term.refresh` throws.** The
  immediate-refresh sits inside a try/catch, so a throw won't break
  activation, but the panel could stay blank for 250ms until the
  fit-driven SIGWINCH pulls Claude's bytes. Acceptable — same
  worst-case as today.

## Known limitations

- We can't tell whether the layout has actually settled at 250ms
  without instrumenting the layout system. The number is empirical
  (matches the existing 180-500ms upper bound). If hardware variance
  pushes layout settling past 250ms on slow machines, the original
  bug returns. A `requestIdleCallback`-with-fallback pattern would be
  more robust, but adds complexity for a problem we haven't
  reproduced. Hold until we see it.

## Out of scope (track separately)

- Long-term: investigate whether the WebGL addon's
  paint-while-hidden behavior can be worked around without manual
  refresh (some addon flag, or replacing visibility-toggle with
  display-toggle that the renderer is happier with).
- Long-term: a debounced `safeFit` on activation that observes the
  container with `ResizeObserver` and only fires once the rect has
  been stable for one frame — the most correct version of "wait for
  layout to settle."
