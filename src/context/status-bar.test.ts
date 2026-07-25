import { describe, expect, test } from "bun:test";
import {
  modelContextAvailability,
  rateLimitAvailability,
  resolveProfileIdForTab,
  shouldApplyProfileRateLimits,
  shouldApplyTabSnapshot,
  type ProfileRateLimitRecord,
  type RateLimitWindows,
  type UsageSnapshot,
} from "./status-bar";
import type { TerminalTab } from "./terminal";

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "tab-1",
    projectPath: "/replace",
    sessionId: null,
    profileId: "default",
    label: "New session",
    status: "running",
    exitCode: null,
    error: null,
    spawnedAt: 1_000,
    needsAttention: false,
    statusBarOverlayInstalled: true,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider_id: "claude",
    tab_id: "tab-1",
    session_id: "sess-1",
    observed_at: 1_000,
    model: { id: "claude-opus-5", display_name: "Opus" },
    context: { used_percentage: 10, remaining_percentage: 90 },
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: 1_700_000_000 },
      seven_day: null,
    },
    ...overrides,
  };
}

function makeRateLimits(usedPct = 10): RateLimitWindows {
  return {
    five_hour: { used_percentage: usedPct, resets_at: 1_700_000_000 },
    seven_day: null,
  };
}

describe("shouldApplyTabSnapshot", () => {
  test("always applies when there is no prior value", () => {
    const incoming = makeSnapshot({ observed_at: 500 });
    expect(shouldApplyTabSnapshot(incoming, undefined)).toBe(true);
  });

  test("applies a strictly newer observed_at", () => {
    const current = makeSnapshot({ observed_at: 1_000 });
    const incoming = makeSnapshot({ observed_at: 1_001 });
    expect(shouldApplyTabSnapshot(incoming, current)).toBe(true);
  });

  test("ignores an equal observed_at", () => {
    const current = makeSnapshot({ observed_at: 1_000 });
    const incoming = makeSnapshot({ observed_at: 1_000 });
    expect(shouldApplyTabSnapshot(incoming, current)).toBe(false);
  });

  test("ignores an older observed_at (a stale pulled read arriving after a fresher live event)", () => {
    const current = makeSnapshot({ observed_at: 2_000 });
    const incoming = makeSnapshot({ observed_at: 1_500 });
    expect(shouldApplyTabSnapshot(incoming, current)).toBe(false);
  });
});

describe("shouldApplyProfileRateLimits", () => {
  test("always applies when there is no prior record and rate_limits is present", () => {
    expect(
      shouldApplyProfileRateLimits(makeRateLimits(), 1_000, undefined),
    ).toBe(true);
  });

  test("never applies when rate_limits is null, even with no prior record", () => {
    expect(shouldApplyProfileRateLimits(null, 1_000, undefined)).toBe(false);
  });

  test("never applies when rate_limits is null, even with a strictly newer observed_at than the current record", () => {
    const current: ProfileRateLimitRecord = {
      rate_limits: makeRateLimits(10),
      observed_at: 1_000,
    };
    // Newer observed_at, but no rate_limits to contribute — must not
    // overwrite (and must not even be compared for staleness against)
    // the existing record. Mirrors freshest_rate_limits in
    // statusline_snapshot.rs.
    expect(shouldApplyProfileRateLimits(null, 9_999, current)).toBe(false);
  });

  test("applies a strictly newer observed_at when rate_limits is present", () => {
    const current: ProfileRateLimitRecord = {
      rate_limits: makeRateLimits(10),
      observed_at: 1_000,
    };
    expect(
      shouldApplyProfileRateLimits(makeRateLimits(50), 1_001, current),
    ).toBe(true);
  });

  test("ignores an equal or older observed_at when rate_limits is present", () => {
    const current: ProfileRateLimitRecord = {
      rate_limits: makeRateLimits(10),
      observed_at: 1_000,
    };
    expect(
      shouldApplyProfileRateLimits(makeRateLimits(50), 1_000, current),
    ).toBe(false);
    expect(
      shouldApplyProfileRateLimits(makeRateLimits(50), 500, current),
    ).toBe(false);
  });
});

describe("resolveProfileIdForTab", () => {
  test("resolves the profileId of an existing tab", () => {
    const tab = makeTab({ id: "tab-a", profileId: "custom:abc123" });
    expect(resolveProfileIdForTab([tab], "tab-a")).toBe("custom:abc123");
  });

  test("returns undefined (not a throw) when the tab no longer exists", () => {
    const tab = makeTab({ id: "tab-a" });
    expect(() => resolveProfileIdForTab([tab], "tab-closed")).not.toThrow();
    expect(resolveProfileIdForTab([tab], "tab-closed")).toBeUndefined();
  });

  test("returns undefined against an empty tab list", () => {
    expect(resolveProfileIdForTab([], "tab-a")).toBeUndefined();
  });
});

describe("modelContextAvailability", () => {
  test("waiting when no snapshot has arrived yet, regardless of overlay state", () => {
    expect(modelContextAvailability(true, undefined)).toBe("waiting");
  });

  test("waiting forever — no elapsed-time threshold flips it to unavailable", () => {
    // There is no time-based parameter on this function at all: the only
    // inputs are overlayInstalled and the (possibly absent) snapshot. This
    // test exists to document/prove that absence, per the task spec — a
    // managed Claude Code policy silently blocking the bridge is
    // indistinguishable in principle from "just hasn't ticked yet", so we
    // must never guess by timing out.
    expect(modelContextAvailability.length).toBe(2);
    expect(modelContextAvailability(true, undefined)).toBe("waiting");
  });

  test("available once a snapshot with model/context populated arrives", () => {
    const snap = makeSnapshot();
    expect(modelContextAvailability(true, snap)).toBe("available");
  });

  test("available for model/context even when that same snapshot's rate_limits is null", () => {
    const snap = makeSnapshot({ rate_limits: null });
    expect(modelContextAvailability(true, snap)).toBe("available");
  });

  test("unavailable when the overlay failed to install (bridge never ran)", () => {
    const snap = makeSnapshot();
    expect(modelContextAvailability(false, snap)).toBe("unavailable");
    expect(modelContextAvailability(false, undefined)).toBe("unavailable");
  });

  test("stays waiting (not unavailable) if a snapshot arrived with neither field populated", () => {
    const snap = makeSnapshot({ model: null, context: null });
    expect(modelContextAvailability(true, snap)).toBe("waiting");
  });
});

describe("rateLimitAvailability", () => {
  test("waiting when no snapshot has arrived yet", () => {
    expect(rateLimitAvailability(true, undefined)).toBe("waiting");
  });

  test("available once a snapshot with rate_limits populated arrives", () => {
    const snap = makeSnapshot();
    expect(rateLimitAvailability(true, snap)).toBe("available");
  });

  test("unavailable when a valid snapshot's rate_limits is null (e.g. API-key billed session)", () => {
    const snap = makeSnapshot({ rate_limits: null });
    expect(rateLimitAvailability(true, snap)).toBe("unavailable");
  });

  test("unavailable when the overlay failed to install, regardless of snapshot", () => {
    expect(rateLimitAvailability(false, undefined)).toBe("unavailable");
    expect(rateLimitAvailability(false, makeSnapshot())).toBe("unavailable");
  });
});
