/**
 * Pure helpers that decide how the side-docked panels (Sessions/Files sidebar
 * and right-hand diff panel) share the outer flex row on window resize. The
 * core concern is that clamping each panel independently to
 * `rowWidth - otherMin` leaves the center below its CENTER_MIN when BOTH
 * panels are at their stored maxima. We compute both effective widths
 * together so the center is always protected.
 *
 * Stored widths (in localStorage) are never mutated here — this is purely a
 * presentation-time projection from stored to what the user sees on screen.
 */

export const SIDEBAR_MIN = 200;
export const DIFF_MIN = 300;
export const CENTER_MIN = 360;

// There is deliberately no SIDEBAR_MAX / DIFF_MAX. Those used to be hard
// pixel ceilings (500 / 800) applied here, at projection time, where the
// drag handle couldn't see them: you could drag past the cap, the stored
// width grew, and the rendered panel didn't move. On a wide display that
// made the panel feel stuck at a fraction of the window (#75).
//
// The only real constraints are geometric — each panel's own minimum, and
// CENTER_MIN for the terminal column — so those are the only ones left.
// Both the drag clamp and this projection derive their maximum from the
// same arithmetic, which is what keeps them agreeing.

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
  /** Diff is auto-hidden when the window is too narrow to host sidebar (if
   *  visible) + diff + a usable center. The user's `diffPanelOpen` flag in
   *  localStorage is unaffected. */
  diffVisible: boolean;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

export function computePanelLayout(input: PanelLayoutInput): PanelLayout {
  const { rowWidth, sidebarVisible, diffOpen, sidebarStored, diffStored } =
    input;

  // Pre-measure tick: ResizeObserver hasn't fired yet. Fall back to stored
  // widths so the first paint doesn't flicker at 0.
  if (rowWidth <= 0) {
    return {
      sidebarEff: sidebarVisible ? sidebarStored : 0,
      diffEff: diffOpen ? diffStored : 0,
      diffVisible: diffOpen,
    };
  }

  const diffFits =
    diffOpen &&
    rowWidth >= DIFF_MIN + CENTER_MIN + (sidebarVisible ? SIDEBAR_MIN : 0);

  if (!sidebarVisible && !diffFits) {
    return { sidebarEff: 0, diffEff: 0, diffVisible: false };
  }

  if (sidebarVisible && !diffFits) {
    const sidebarEff = clamp(sidebarStored, SIDEBAR_MIN, rowWidth - CENTER_MIN);
    return { sidebarEff: Math.floor(sidebarEff), diffEff: 0, diffVisible: false };
  }

  if (!sidebarVisible && diffFits) {
    const diffEff = clamp(diffStored, DIFF_MIN, rowWidth - CENTER_MIN);
    return { sidebarEff: 0, diffEff: Math.floor(diffEff), diffVisible: true };
  }

  // Both visible. Each panel may grow until it would push the other below
  // its minimum or eat into CENTER_MIN. If the two stored widths still add
  // up to more than the row can give, scale both down proportionally —
  // never below their individual mins.
  const available = rowWidth - CENTER_MIN;
  const sidebarPref = Math.min(sidebarStored, available - DIFF_MIN);
  const diffPref = Math.min(diffStored, available - SIDEBAR_MIN);

  if (sidebarPref + diffPref <= available) {
    return {
      sidebarEff: Math.floor(Math.max(SIDEBAR_MIN, sidebarPref)),
      diffEff: Math.floor(Math.max(DIFF_MIN, diffPref)),
      diffVisible: true,
    };
  }

  const ratio = available / (sidebarPref + diffPref);
  const sidebarScaled = sidebarPref * ratio;
  const diffScaled = diffPref * ratio;
  let sidebarEff = Math.max(SIDEBAR_MIN, sidebarScaled);
  let diffEff = Math.max(DIFF_MIN, diffScaled);

  // When one panel's scaled-down width falls below its hard minimum it gets
  // clamped up, which hands back extra pixels the other panel was counting
  // on. Subtract that overshoot from the other side (respecting its own
  // min) so the center keeps its CENTER_MIN floor.
  const overshoot =
    sidebarEff - sidebarScaled + (diffEff - diffScaled);
  if (overshoot > 0) {
    if (sidebarEff === SIDEBAR_MIN) {
      diffEff = Math.max(DIFF_MIN, diffEff - overshoot);
    } else {
      sidebarEff = Math.max(SIDEBAR_MIN, sidebarEff - overshoot);
    }
  }
  // Round DOWN to whole pixels — we render at pixel granularity anyway,
  // and floor guarantees the CENTER_MIN invariant holds without relying on
  // float precision (a 359.99999... center is indistinguishable from 360
  // on screen but the invariant test cares).
  return {
    sidebarEff: Math.floor(sidebarEff),
    diffEff: Math.floor(diffEff),
    diffVisible: true,
  };
}
