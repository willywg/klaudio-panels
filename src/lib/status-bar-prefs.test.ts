import { beforeEach, describe, expect, test } from "bun:test";
import { getPrefs, setPrefs, type StatusBarPrefs } from "./status-bar-prefs";

/** Bun's default test runtime has no `localStorage` global (no DOM, no
 *  preload) — stub a minimal in-memory implementation, reset before every
 *  test so cases can't bleed into each other. Same helper shape as
 *  `components/last-session.test.ts`. */
function installFakeLocalStorage(): void {
  const data = new Map<string, string>();
  const fake = {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => {
      data.clear();
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
  globalThis.localStorage = fake as unknown as Storage;
}

const DEFAULTS: StatusBarPrefs = {
  enabled: true,
  sections: { model: true, git: true, usage5h: true, usageWeekly: true },
  usageIntegrationEnabled: true,
  showAsRemainingVsUsed: "used",
  resetDisplay: "countdown",
  usageBars: "auto",
  profileAliases: {},
};

beforeEach(() => {
  installFakeLocalStorage();
});

describe("status-bar-prefs", () => {
  test("getPrefs returns full defaults when nothing is stored", () => {
    expect(getPrefs()).toEqual(DEFAULTS);
  });

  test("getPrefs returns full defaults when the stored value is malformed JSON", () => {
    localStorage.setItem("statusBarPrefs", "{not valid json");
    expect(getPrefs()).toEqual(DEFAULTS);
  });

  test("getPrefs default-fills missing top-level fields", () => {
    localStorage.setItem(
      "statusBarPrefs",
      JSON.stringify({ enabled: false }),
    );
    expect(getPrefs()).toEqual({ ...DEFAULTS, enabled: false });
  });

  test("getPrefs default-fills a partially-populated nested sections object", () => {
    localStorage.setItem(
      "statusBarPrefs",
      JSON.stringify({ sections: { model: false } }),
    );
    expect(getPrefs()).toEqual({
      ...DEFAULTS,
      sections: { model: false, git: true, usage5h: true, usageWeekly: true },
    });
  });

  test("getPrefs default-fills when sections is entirely missing", () => {
    localStorage.setItem(
      "statusBarPrefs",
      JSON.stringify({ resetDisplay: "timestamp" }),
    );
    expect(getPrefs()).toEqual({ ...DEFAULTS, resetDisplay: "timestamp" });
  });

  test("getPrefs preserves stored profileAliases and merges with an empty default", () => {
    localStorage.setItem(
      "statusBarPrefs",
      JSON.stringify({ profileAliases: { default: "Work" } }),
    );
    expect(getPrefs()).toEqual({
      ...DEFAULTS,
      profileAliases: { default: "Work" },
    });
  });

  test("setPrefs merges a top-level patch against the existing stored value", () => {
    setPrefs({ enabled: false });
    setPrefs({ resetDisplay: "timestamp" });
    expect(getPrefs()).toEqual({
      ...DEFAULTS,
      enabled: false,
      resetDisplay: "timestamp",
    });
  });

  test("setPrefs merges a nested sections patch without clobbering untouched keys", () => {
    setPrefs({ sections: { git: false } });
    expect(getPrefs().sections).toEqual({
      model: true,
      git: false,
      usage5h: true,
      usageWeekly: true,
    });

    setPrefs({ sections: { usage5h: false } });
    expect(getPrefs().sections).toEqual({
      model: true,
      git: false,
      usage5h: false,
      usageWeekly: true,
    });
  });

  test("getPrefs default-fills usageBars to 'auto' when absent", () => {
    localStorage.setItem(
      "statusBarPrefs",
      JSON.stringify({ enabled: false }),
    );
    expect(getPrefs().usageBars).toBe("auto");
  });

  test("setPrefs updates usageBars independently of other fields", () => {
    setPrefs({ usageBars: "always" });
    expect(getPrefs()).toEqual({ ...DEFAULTS, usageBars: "always" });

    setPrefs({ usageBars: "never" });
    expect(getPrefs().usageBars).toBe("never");
  });

  test("setPrefs merges profileAliases additively across calls", () => {
    setPrefs({ profileAliases: { default: "Work" } });
    setPrefs({ profileAliases: { "custom:abc123": "Personal" } });
    expect(getPrefs().profileAliases).toEqual({
      default: "Work",
      "custom:abc123": "Personal",
    });
  });
});
