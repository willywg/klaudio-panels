import { describe, expect, test } from "bun:test";

/** This repo has no DOM/component-render test harness (no jsdom/happy-dom,
 *  no @solidjs/testing-library — confirmed by grep before adding this
 *  file), so the flex/overflow layout contract that keeps the footer
 *  inside the viewport and the terminal region correctly clipped can't be
 *  asserted by rendering. Instead these tests grep the actual component
 *  source for the literal Tailwind classes/APIs the contract depends on,
 *  so an edit that silently drops `shrink-0`, `min-h-0`, or the
 *  ResizeObserver wiring fails a test instead of only showing up as a
 *  live clipping bug. */

const appSource = await Bun.file(new URL("./App.tsx", import.meta.url)).text();
const statusBarSource = await Bun.file(
  new URL("./components/status-bar.tsx", import.meta.url),
).text();
const popoverSource = await Bun.file(
  new URL("./components/status-bar-popover.tsx", import.meta.url),
).text();
const terminalViewSource = await Bun.file(
  new URL("./components/terminal-view.tsx", import.meta.url),
).text();
const titlebarSource = await Bun.file(
  new URL("./components/titlebar.tsx", import.meta.url),
).text();

function classesOf(source: string, openTagPattern: RegExp): string {
  const match = source.match(openTagPattern);
  if (!match) throw new Error(`pattern not found: ${openTagPattern}`);
  return match[1];
}

describe("app shell flex contract (App.tsx)", () => {
  test("root is a full-viewport, non-scrolling flex column", () => {
    const classes = classesOf(appSource, /<div class="(h-screen[^"]*)"/);
    expect(classes).toContain("h-screen");
    expect(classes).toMatch(/(^|\s)flex(\s|$)/);
    expect(classes).toContain("flex-col");
    expect(classes).toContain("overflow-hidden");
  });

  test("main terminal region is flex-1 with min-h-0 and clips its own overflow", () => {
    const classes = classesOf(appSource, /<main class="([^"]*)"/);
    expect(classes).toContain("flex-1");
    expect(classes).toContain("min-h-0");
    expect(classes).toContain("overflow-hidden");
  });

  test("StatusBar is mounted as a sibling after </main>, not inside it", () => {
    const mainCloseIndex = appSource.indexOf("</main>");
    const statusBarIndex = appSource.indexOf("<StatusBar");
    expect(mainCloseIndex).toBeGreaterThan(-1);
    expect(statusBarIndex).toBeGreaterThan(mainCloseIndex);
  });

  test("titlebar is a fixed, non-shrinking header (won't grow and eat the footer's space)", () => {
    const classes = classesOf(titlebarSource, /<header\s+class="([^"]*)"/);
    expect(classes).toContain("h-10");
    expect(classes).toContain("shrink-0");
  });

  test("every nested flex-1 region between <main> and </main> carries min-h-0", () => {
    // Coarse but effective: main's own min-h-0 is asserted above by tag; this
    // guards the *intermediate* flex-1 containers (sidebar row, center
    // column, split container, tab section, tab-content wrapper) that sit
    // between <main> and the xterm mount — a flex-1 child without min-h-0
    // defaults to min-height:auto and can refuse to shrink below its
    // content size, which is exactly the failure mode that pushes a
    // sibling footer off the bottom of the viewport.
    const mainStart = appSource.indexOf("<main");
    const mainEnd = appSource.indexOf("</main>");
    expect(mainStart).toBeGreaterThan(-1);
    expect(mainEnd).toBeGreaterThan(mainStart);
    const mainRegion = appSource.slice(mainStart, mainEnd);
    const minHeightZeroCount = (mainRegion.match(/min-h-0/g) ?? []).length;
    expect(minHeightZeroCount).toBeGreaterThanOrEqual(5);
  });
});

describe("footer height contract (status-bar.tsx)", () => {
  test("footer has a non-shrinking, ~26-30px explicit height and clips its own overflow", () => {
    const classes = classesOf(statusBarSource, /<footer\s+ref=\{footerRef\}\s+class="([^"]*)"/);
    expect(classes).toContain("shrink-0");
    expect(classes).toContain("overflow-hidden");
    expect(classes).toContain("items-center");
    expect(classes).not.toMatch(/flex-wrap/);
    const heightMatch = classes.match(/h-\[(\d+)px\]/);
    expect(heightMatch).not.toBeNull();
    const heightPx = Number(heightMatch![1]);
    expect(heightPx).toBeGreaterThanOrEqual(26);
    expect(heightPx).toBeLessThanOrEqual(30);
  });
});

describe("popover escapes the footer's overflow-hidden box (status-bar-popover.tsx)", () => {
  test("popover content renders through a Portal, not as an in-flow footer child", () => {
    expect(popoverSource).toContain("<Portal>");
    expect(popoverSource).toMatch(/import\s*\{[^}]*Portal[^}]*\}\s*from\s*"solid-js\/web"/);
  });
});

describe("terminal refit wiring (terminal-view.tsx)", () => {
  test("a ResizeObserver on the terminal's own container drives refit, covering any footer/layout height change", () => {
    expect(terminalViewSource).toContain("new ResizeObserver(");
    expect(terminalViewSource).toMatch(/resizeObs\.observe\(container/);
  });

  test("a window-level resize listener backs up the ResizeObserver", () => {
    expect(terminalViewSource).toMatch(/window\.addEventListener\(\s*"resize"/);
  });
});
