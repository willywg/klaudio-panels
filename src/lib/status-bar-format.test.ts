import { describe, expect, test } from "bun:test";
import {
  clampPercentage,
  contextBarColorClass,
  contextSeverity,
  displayPercentage,
  formatCountdown,
  formatResetTime,
  formatResetTimestamp,
  formatUsagePart,
  isStale,
  modelContextUnavailableTooltip,
  narrowLevelForWidth,
  profileDisplayLabel,
  profileRowLabel,
  rateLimitUnavailableTooltip,
  shouldShowUsageBars,
  usageAriaLabel,
  usageBarAriaLabel,
  usageBarValue,
  USAGE_BARS_MIN_WIDTH,
  visibilityForLevel,
  wideEnoughForUsageBars,
} from "./status-bar-format";

describe("narrowLevelForWidth / visibilityForLevel", () => {
  test("full width shows everything", () => {
    expect(narrowLevelForWidth(700)).toBe(0);
    expect(visibilityForLevel(0)).toEqual({
      weekly: true,
      fiveHour: true,
      git: true,
      alias: true,
      usageCluster: true,
    });
  });

  test("drops weekly first", () => {
    const level = narrowLevelForWidth(500);
    expect(level).toBe(1);
    const v = visibilityForLevel(level);
    expect(v.weekly).toBe(false);
    expect(v.fiveHour).toBe(true);
    expect(v.git).toBe(true);
    expect(v.alias).toBe(true);
  });

  test("drops weekly then 5h, keeping the alias alone", () => {
    const level = narrowLevelForWidth(420);
    expect(level).toBe(2);
    const v = visibilityForLevel(level);
    expect(v.weekly).toBe(false);
    expect(v.fiveHour).toBe(false);
    expect(v.git).toBe(true);
    expect(v.alias).toBe(true);
    expect(v.usageCluster).toBe(true);
  });

  test("drops the git widget next", () => {
    const level = narrowLevelForWidth(340);
    expect(level).toBe(3);
    const v = visibilityForLevel(level);
    expect(v.git).toBe(false);
    expect(v.alias).toBe(true);
  });

  test("floor: only the model+context anchor survives — alias and the whole usage cluster are gone", () => {
    const level = narrowLevelForWidth(100);
    expect(level).toBe(4);
    const v = visibilityForLevel(level);
    expect(v.weekly).toBe(false);
    expect(v.fiveHour).toBe(false);
    expect(v.git).toBe(false);
    expect(v.alias).toBe(false);
    expect(v.usageCluster).toBe(false);
  });

  test("never returns a level outside 0-4", () => {
    for (const w of [-100, 0, 1, 10_000]) {
      const level = narrowLevelForWidth(w);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(4);
    }
  });
});

describe("contextSeverity / contextBarColorClass", () => {
  test("normal under 70%", () => {
    expect(contextSeverity(0)).toBe("normal");
    expect(contextSeverity(69.9)).toBe("normal");
    expect(contextBarColorClass(50)).toBe("bg-neutral-500");
  });

  test("warning from 70% up to and including 90%", () => {
    expect(contextSeverity(70)).toBe("warning");
    expect(contextSeverity(90)).toBe("warning");
    expect(contextBarColorClass(80)).toBe("bg-amber-400");
  });

  test("critical strictly above 90%", () => {
    expect(contextSeverity(90.1)).toBe("critical");
    expect(contextSeverity(100)).toBe("critical");
    expect(contextBarColorClass(95)).toBe("bg-rose-400");
  });
});

describe("displayPercentage / formatUsagePart", () => {
  test("used mode returns the raw (rounded) used percentage", () => {
    expect(displayPercentage(31.4, "used")).toBe(31);
    expect(formatUsagePart("5h", 31.4, "used")).toBe("5h 31%");
  });

  test("remaining mode returns the complement and adds a 'left' suffix", () => {
    expect(displayPercentage(31, "remaining")).toBe(69);
    expect(formatUsagePart("5h", 31, "remaining")).toBe("5h 69% left");
  });
});

describe("formatCountdown", () => {
  const now = Date.parse("2026-07-25T10:00:00Z");

  test("formats days + hours when more than a day remains", () => {
    const resetsAt = now / 1000 + 3 * 86_400 + 4 * 3_600;
    expect(formatCountdown(resetsAt, now)).toBe("in 3d 4h");
  });

  test("formats hours + minutes when under a day remains", () => {
    const resetsAt = now / 1000 + 2 * 3_600 + 14 * 60;
    expect(formatCountdown(resetsAt, now)).toBe("in 2h 14m");
  });

  test("formats minutes only when under an hour remains", () => {
    const resetsAt = now / 1000 + 45 * 60;
    expect(formatCountdown(resetsAt, now)).toBe("in 45m");
  });

  test("formats 'in <1m' when under a minute remains", () => {
    const resetsAt = now / 1000 + 30;
    expect(formatCountdown(resetsAt, now)).toBe("in <1m");
  });

  test("formats 'now' once the reset has passed — never a negative countdown", () => {
    expect(formatCountdown(now / 1000 - 1, now)).toBe("now");
    expect(formatCountdown(now / 1000, now)).toBe("now");
  });
});

describe("formatResetTimestamp / formatResetTime", () => {
  test("produces a weekday + time string", () => {
    const resetsAt = Date.parse("2026-07-28T10:00:00Z") / 1000;
    const out = formatResetTimestamp(resetsAt);
    expect(out).toMatch(/^[A-Za-z]{3} /);
    expect(out).toContain("10:00");
  });

  test("formatResetTime dispatches on mode", () => {
    const now = Date.parse("2026-07-25T10:00:00Z");
    const resetsAt = now / 1000 + 3_600;
    expect(formatResetTime(resetsAt, "countdown", now)).toBe("in 1h 0m");
    expect(formatResetTime(resetsAt, "timestamp", now)).toBe(
      formatResetTimestamp(resetsAt),
    );
  });
});

describe("isStale", () => {
  const now = 1_000_000;

  test("an exited tab is always stale, regardless of observedAt", () => {
    expect(isStale("exited", now, now)).toBe(true);
  });

  test("a running tab is stale once 5+ minutes have passed", () => {
    expect(isStale("running", now - 5 * 60 * 1000 - 1, now)).toBe(true);
    expect(isStale("running", now - 5 * 60 * 1000, now)).toBe(false);
    expect(isStale("running", now - 1000, now)).toBe(false);
  });
});

describe("modelContextUnavailableTooltip / rateLimitUnavailableTooltip", () => {
  test("model/context unavailable is always the bridge-never-ran message", () => {
    expect(modelContextUnavailableTooltip()).toBe(
      "Status bar couldn't start for this session",
    );
  });

  test("rate-limit unavailable distinguishes overlay-missing from API-key billing", () => {
    expect(rateLimitUnavailableTooltip(false)).toBe(
      "Status bar couldn't start for this session",
    );
    expect(rateLimitUnavailableTooltip(true)).toBe(
      "This profile is billed by API key — usage windows don't apply",
    );
  });
});

describe("profileDisplayLabel", () => {
  test("uses the stored alias when present", () => {
    expect(profileDisplayLabel("custom:abc", { "custom:abc": "Work" })).toBe(
      "Work",
    );
  });

  test("falls back to 'Default' for the literal default profileId", () => {
    expect(profileDisplayLabel("default", {})).toBe("Default");
  });

  test("falls back to 'Unnamed profile' for an unaliased custom profile — never the raw id", () => {
    const label = profileDisplayLabel("custom:c29tZS1zZWNyZXQ=", {});
    expect(label).toBe("Unnamed profile");
    expect(label).not.toContain("custom:");
  });

  test("falls back to 'Unnamed profile' when profileId itself is undefined", () => {
    expect(profileDisplayLabel(undefined, {})).toBe("Unnamed profile");
  });

  test("an empty-string alias does not count as set", () => {
    expect(profileDisplayLabel("default", { default: "  " })).toBe("Default");
  });
});

describe("profileRowLabel", () => {
  test("uses the stored alias when present", () => {
    expect(profileRowLabel("custom:abc", { "custom:abc": "Personal" })).toBe(
      "Personal",
    );
  });

  test("falls back to 'Default' for the default profile", () => {
    expect(profileRowLabel("default", {})).toBe("Default");
  });

  test("is blank (not the raw id) for an unaliased custom profile", () => {
    const label = profileRowLabel("custom:c29tZS1zZWNyZXQ=", {});
    expect(label).toBe("");
  });
});

describe("usageAriaLabel", () => {
  test("waiting state", () => {
    expect(
      usageAriaLabel({ availability: "waiting", mode: "used" }),
    ).toBe("Usage: waiting for data");
  });

  test("unavailable state", () => {
    expect(
      usageAriaLabel({ availability: "unavailable", mode: "used" }),
    ).toBe("Usage: not available");
  });

  test("available state includes both windows and the alias prefix when given", () => {
    const label = usageAriaLabel({
      availability: "available",
      alias: "Work",
      fiveHourUsedPercentage: 42,
      weeklyUsedPercentage: 18,
      mode: "used",
    });
    expect(label).toBe(
      "Work usage: 5 hour window 42%, weekly window 18%",
    );
  });

  test("available state with only one window present omits the other", () => {
    const label = usageAriaLabel({
      availability: "available",
      fiveHourUsedPercentage: 42,
      weeklyUsedPercentage: null,
      mode: "used",
    });
    expect(label).toBe("Usage: 5 hour window 42%");
  });

  test("respects the remaining display mode", () => {
    const label = usageAriaLabel({
      availability: "available",
      fiveHourUsedPercentage: 42,
      mode: "remaining",
    });
    expect(label).toBe("Usage: 5 hour window 58% left");
  });
});

describe("clampPercentage", () => {
  test("passes values already within 0-100 through unchanged", () => {
    expect(clampPercentage(0)).toBe(0);
    expect(clampPercentage(9)).toBe(9);
    expect(clampPercentage(90)).toBe(90);
    expect(clampPercentage(100)).toBe(100);
  });

  test("clamps above-range values down to 100", () => {
    expect(clampPercentage(150)).toBe(100);
    expect(clampPercentage(100.1)).toBe(100);
  });

  test("clamps below-range (negative) values up to 0", () => {
    expect(clampPercentage(-5)).toBe(0);
    expect(clampPercentage(-0.1)).toBe(0);
  });
});

describe("usageBarValue", () => {
  test("renders 9% and 90% widths exactly, unrounded inputs included", () => {
    expect(usageBarValue(9)).toBe(9);
    expect(usageBarValue(90)).toBe(90);
    expect(usageBarValue(9.4)).toBe(9);
    expect(usageBarValue(89.6)).toBe(90);
  });

  test("clamps out-of-range values before rounding", () => {
    expect(usageBarValue(150)).toBe(100);
    expect(usageBarValue(-20)).toBe(0);
  });
});

describe("usageBarAriaLabel", () => {
  test("matches the required phrasing exactly", () => {
    expect(usageBarAriaLabel("Weekly usage", 90)).toBe(
      "Weekly usage: 90 percent used",
    );
    expect(usageBarAriaLabel("5-hour usage", 31.4)).toBe(
      "5-hour usage: 31 percent used",
    );
  });

  test("clamps before formatting", () => {
    expect(usageBarAriaLabel("Weekly usage", 130)).toBe(
      "Weekly usage: 100 percent used",
    );
  });

  test("usageBarValue's rounded output must never be fed to contextBarColorClass — a borderline raw percentage would cross the severity threshold if rounded first", () => {
    const raw = 90.4;
    expect(contextSeverity(raw)).toBe("critical");
    expect(contextBarColorClass(raw)).toBe("bg-rose-400");
    // Rounding first (what usageBarValue produces, used for fill width
    // and the visible "%") shifts this same value into the warning
    // bucket — status-bar.tsx's UsageBar and status-bar-popover.tsx's
    // PopoverUsageBar must call contextBarColorClass with the raw
    // percentage, never with usageBarValue(raw).
    const rounded = usageBarValue(raw);
    expect(contextSeverity(rounded)).toBe("warning");
  });
});

describe("wideEnoughForUsageBars / shouldShowUsageBars", () => {
  test("wideEnoughForUsageBars is gated on USAGE_BARS_MIN_WIDTH, strictly wider than narrowLevelForWidth's own full-width level", () => {
    expect(USAGE_BARS_MIN_WIDTH).toBeGreaterThan(560);
    expect(wideEnoughForUsageBars(USAGE_BARS_MIN_WIDTH)).toBe(true);
    expect(wideEnoughForUsageBars(USAGE_BARS_MIN_WIDTH - 1)).toBe(false);
  });

  test("'never' hides bars regardless of width", () => {
    expect(shouldShowUsageBars("never", 10_000)).toBe(false);
    expect(shouldShowUsageBars("never", 0)).toBe(false);
  });

  test("'always' shows bars regardless of width", () => {
    expect(shouldShowUsageBars("always", 0)).toBe(true);
    expect(shouldShowUsageBars("always", 10)).toBe(true);
  });

  test("'auto' shows bars only once wide enough — the responsive text-only fallback below that", () => {
    expect(shouldShowUsageBars("auto", USAGE_BARS_MIN_WIDTH)).toBe(true);
    expect(shouldShowUsageBars("auto", USAGE_BARS_MIN_WIDTH + 200)).toBe(true);
    expect(shouldShowUsageBars("auto", USAGE_BARS_MIN_WIDTH - 1)).toBe(false);
    expect(shouldShowUsageBars("auto", 300)).toBe(false);
  });
});
