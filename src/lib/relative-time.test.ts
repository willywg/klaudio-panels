import { describe, expect, test } from "bun:test";
import { commitTime, relativeTime } from "@/lib/relative-time";

/** 2026-08-20T18:00:00Z, as a fixed "now" so nothing here depends on when
 *  the suite runs. */
const NOW = Date.UTC(2026, 7, 20, 18, 0, 0);

const secondsAgo = (n: number) => Math.floor(NOW / 1000) - n;
const HOUR = 3600;
const DAY = 24 * HOUR;

describe("commitTime", () => {
  test("recent commits read relative", () => {
    // "did Claude just do this?" is the question this half answers.
    expect(commitTime(secondsAgo(2 * HOUR), NOW)).toBe("2h ago");
    expect(commitTime(secondsAgo(10), NOW)).toBe("now");
    expect(commitTime(secondsAgo(3 * DAY), NOW)).toBe("3d ago");
  });

  test("past a week it switches to a calendar date", () => {
    // `relativeTime` keeps counting days forever, and "412d ago" tells you
    // nothing you can place. The cutoff is where the day count stops
    // meaning something.
    expect(commitTime(secondsAgo(6 * DAY), NOW)).toBe("6d ago");
    expect(commitTime(secondsAgo(8 * DAY), NOW)).not.toContain("ago");
  });

  test("an older year is named, the current one isn't", () => {
    const thisYear = commitTime(secondsAgo(60 * DAY), NOW);
    const lastYear = commitTime(secondsAgo(400 * DAY), NOW);
    expect(thisYear).not.toContain("2026");
    expect(thisYear).not.toContain("2025");
    expect(lastYear).toContain("2025");
  });

  test("git's seconds are not read as millis", () => {
    // The backend hands out Unix *seconds*; treating them as millis would
    // date every commit to January 1970.
    expect(commitTime(secondsAgo(HOUR), NOW)).toBe("1h ago");
  });
});

describe("relativeTime", () => {
  test("keeps counting in days, which is why commitTime exists", () => {
    expect(relativeTime(NOW - 400 * DAY * 1000, NOW)).toBe("400d ago");
  });

  test("a future timestamp clamps to now rather than counting backwards", () => {
    expect(relativeTime(NOW + 5000, NOW)).toBe("now");
  });
});
