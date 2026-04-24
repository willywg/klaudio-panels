import { describe, expect, test } from "bun:test";
import {
  CENTER_MIN,
  DIFF_MAX,
  DIFF_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  computePanelLayout,
} from "./panel-layout";

describe("computePanelLayout", () => {
  test("pre-measure tick returns stored widths without clamping", () => {
    const r = computePanelLayout({
      rowWidth: 0,
      sidebarVisible: true,
      diffOpen: true,
      sidebarStored: 280,
      diffStored: 640,
    });
    expect(r.sidebarEff).toBe(280);
    expect(r.diffEff).toBe(640);
    expect(r.diffVisible).toBe(true);
  });

  test("only sidebar visible: clamps against rowWidth - CENTER_MIN", () => {
    const r = computePanelLayout({
      rowWidth: 900,
      sidebarVisible: true,
      diffOpen: false,
      sidebarStored: 700,
      diffStored: 640,
    });
    expect(r.sidebarEff).toBeLessThanOrEqual(SIDEBAR_MAX);
    expect(r.diffEff).toBe(0);
    expect(r.diffVisible).toBe(false);
  });

  test("only diff visible: clamps against rowWidth - CENTER_MIN", () => {
    const r = computePanelLayout({
      rowWidth: 900,
      sidebarVisible: false,
      diffOpen: true,
      sidebarStored: 280,
      diffStored: 900,
    });
    expect(r.sidebarEff).toBe(0);
    expect(r.diffEff).toBeLessThanOrEqual(DIFF_MAX);
    expect(r.diffEff).toBe(Math.min(DIFF_MAX, 900 - CENTER_MIN));
    expect(r.diffVisible).toBe(true);
  });

  test("auto-hides diff when window narrower than sidebar + diff + center mins", () => {
    const threshold = DIFF_MIN + CENTER_MIN + SIDEBAR_MIN; // 860
    const r = computePanelLayout({
      rowWidth: threshold - 1,
      sidebarVisible: true,
      diffOpen: true,
      sidebarStored: 280,
      diffStored: 640,
    });
    expect(r.diffVisible).toBe(false);
    expect(r.diffEff).toBe(0);
    // sidebar takes what remains after CENTER_MIN
    expect(r.sidebarEff + CENTER_MIN).toBeLessThanOrEqual(threshold - 1);
  });

  test("both visible with defaults on a medium window: center stays >= CENTER_MIN", () => {
    const rowWidth = 1000;
    const r = computePanelLayout({
      rowWidth,
      sidebarVisible: true,
      diffOpen: true,
      sidebarStored: 280,
      diffStored: 640,
    });
    expect(r.diffVisible).toBe(true);
    const center = rowWidth - r.sidebarEff - r.diffEff;
    expect(center).toBeGreaterThanOrEqual(CENTER_MIN);
  });

  // The blocker case the advisor caught: at the auto-hide threshold
  // exactly, proportional scaling bumped one panel UP to its min and
  // left the center at 357.2px. The second-pass overshoot correction
  // must restore the 360px floor.
  test("both visible at auto-hide threshold: second-pass keeps center at CENTER_MIN", () => {
    const rowWidth = DIFF_MIN + CENTER_MIN + SIDEBAR_MIN; // 860
    const r = computePanelLayout({
      rowWidth,
      sidebarVisible: true,
      diffOpen: true,
      sidebarStored: 280,
      diffStored: 640,
    });
    expect(r.diffVisible).toBe(true);
    const center = rowWidth - r.sidebarEff - r.diffEff;
    expect(center).toBeGreaterThanOrEqual(CENTER_MIN);
  });

  test("both visible: never below individual mins", () => {
    const r = computePanelLayout({
      rowWidth: 870,
      sidebarVisible: true,
      diffOpen: true,
      sidebarStored: 1000, // wants more than it'll get
      diffStored: 1000,
    });
    expect(r.sidebarEff).toBeGreaterThanOrEqual(SIDEBAR_MIN);
    expect(r.diffEff).toBeGreaterThanOrEqual(DIFF_MIN);
  });

  test("both visible on wide window: respects absolute maxes, center gets leftover", () => {
    const rowWidth = 2400;
    const r = computePanelLayout({
      rowWidth,
      sidebarVisible: true,
      diffOpen: true,
      sidebarStored: SIDEBAR_MAX + 200, // asks for more than cap
      diffStored: DIFF_MAX + 200,
    });
    expect(r.sidebarEff).toBeLessThanOrEqual(SIDEBAR_MAX);
    expect(r.diffEff).toBeLessThanOrEqual(DIFF_MAX);
    const center = rowWidth - r.sidebarEff - r.diffEff;
    expect(center).toBeGreaterThanOrEqual(CENTER_MIN);
  });

  test("both visible: sum never exceeds rowWidth - CENTER_MIN", () => {
    // Stress across a sweep — this is the core invariant.
    const stored = { sidebar: 400, diff: 700 };
    for (let w = 860; w <= 2000; w += 37) {
      const r = computePanelLayout({
        rowWidth: w,
        sidebarVisible: true,
        diffOpen: true,
        sidebarStored: stored.sidebar,
        diffStored: stored.diff,
      });
      if (!r.diffVisible) continue;
      const center = w - r.sidebarEff - r.diffEff;
      expect(center).toBeGreaterThanOrEqual(CENTER_MIN);
    }
  });

  test("stored widths are not echoed when they exceed the row budget", () => {
    const r = computePanelLayout({
      rowWidth: 1200,
      sidebarVisible: true,
      diffOpen: true,
      sidebarStored: 1000,
      diffStored: 1000,
    });
    expect(r.sidebarEff + r.diffEff).toBeLessThanOrEqual(1200 - CENTER_MIN);
  });
});
