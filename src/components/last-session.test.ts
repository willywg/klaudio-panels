import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearLegacyLastSessionId,
  getLastSessionId,
  getLegacyLastSessionId,
  lastSessionKey,
  legacyLastSessionKey,
  preAgentLastSessionKey,
  setLastSessionId,
} from "./last-session";
import { CLAUDE } from "@/lib/agents";

const CURSOR = "cursor" as typeof CLAUDE;

/** Bun's default test runtime has no `localStorage` global (no DOM, no
 *  preload) — stub a minimal in-memory implementation, reset before every
 *  test so cases can't bleed into each other. */
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

beforeEach(() => {
  installFakeLocalStorage();
});

describe("last-session", () => {
  test("default and custom profiles produce different storage keys", () => {
    setLastSessionId("/proj", CLAUDE, "default", "default-profile-session");
    setLastSessionId("/proj", CLAUDE, "custom:abc123", "replace-session");

    expect(getLastSessionId("/proj", CLAUDE, "default")).toBe(
      "default-profile-session",
    );
    expect(getLastSessionId("/proj", CLAUDE, "custom:abc123")).toBe(
      "replace-session",
    );
  });

  test("two agents on the same project and profile never collide", () => {
    setLastSessionId("/proj", CLAUDE, "default", "claude-session");
    setLastSessionId("/proj", CURSOR, "default", "cursor-chat");

    expect(getLastSessionId("/proj", CLAUDE, "default")).toBe("claude-session");
    expect(getLastSessionId("/proj", CURSOR, "default")).toBe("cursor-chat");
    expect(lastSessionKey("/proj", CLAUDE, "default")).not.toBe(
      lastSessionKey("/proj", CURSOR, "default"),
    );
  });

  test("clearing one profile's key does not touch the other's", () => {
    setLastSessionId("/proj", CLAUDE, "default", "default-profile-session");
    setLastSessionId("/proj", CLAUDE, "custom:abc123", "replace-session");

    setLastSessionId("/proj", CLAUDE, "default", null);

    expect(getLastSessionId("/proj", CLAUDE, "default")).toBeNull();
    expect(getLastSessionId("/proj", CLAUDE, "custom:abc123")).toBe(
      "replace-session",
    );
  });

  test("the namespaced getter never falls back to the legacy key", () => {
    localStorage.setItem(legacyLastSessionKey("/proj"), "old-default-profile-session");

    expect(getLastSessionId("/proj", CLAUDE, "default")).toBeNull();
    expect(getLastSessionId("/proj", CLAUDE, "custom:abc123")).toBeNull();
  });

  test("legacy pointer is readable and clearable independently", () => {
    localStorage.setItem(legacyLastSessionKey("/proj"), "old-default-profile-session");

    expect(getLegacyLastSessionId("/proj")).toBe("old-default-profile-session");
    clearLegacyLastSessionId("/proj");
    expect(getLegacyLastSessionId("/proj")).toBeNull();
  });
});

// Every key written before agents existed was written by Claude, which is
// the whole reason this migration can run without asking anyone. It has to
// happen exactly once, leave nothing behind to resurrect later, and not
// invent a value for an agent that never wrote one.
describe("pre-agent key migration", () => {
  test("an upgraded install finds its remembered session under the new key", () => {
    localStorage.setItem(
      preAgentLastSessionKey("/proj", "default"),
      "before-upgrade",
    );

    expect(getLastSessionId("/proj", CLAUDE, "default")).toBe("before-upgrade");
    expect(localStorage.getItem(lastSessionKey("/proj", CLAUDE, "default"))).toBe(
      "before-upgrade",
    );
    expect(
      localStorage.getItem(preAgentLastSessionKey("/proj", "default")),
    ).toBeNull();
  });

  test("migration carries a custom profile across as itself", () => {
    localStorage.setItem(
      preAgentLastSessionKey("/proj", "custom:abc123"),
      "custom-session",
    );

    expect(getLastSessionId("/proj", CLAUDE, "custom:abc123")).toBe(
      "custom-session",
    );
    expect(getLastSessionId("/proj", CLAUDE, "default")).toBeNull();
  });

  test("the new key wins when both exist", () => {
    localStorage.setItem(preAgentLastSessionKey("/proj", "default"), "stale");
    localStorage.setItem(lastSessionKey("/proj", CLAUDE, "default"), "current");

    expect(getLastSessionId("/proj", CLAUDE, "default")).toBe("current");
  });

  test("another agent never adopts Claude's pre-agent key", () => {
    localStorage.setItem(
      preAgentLastSessionKey("/proj", "default"),
      "claude-session",
    );

    expect(getLastSessionId("/proj", CURSOR, "default")).toBeNull();
    // and reading under Cursor must not have consumed Claude's value
    expect(getLastSessionId("/proj", CLAUDE, "default")).toBe("claude-session");
  });

  test("a write retires the old spelling so it cannot resurrect", () => {
    localStorage.setItem(preAgentLastSessionKey("/proj", "default"), "stale");
    setLastSessionId("/proj", CLAUDE, "default", "fresh");

    expect(
      localStorage.getItem(preAgentLastSessionKey("/proj", "default")),
    ).toBeNull();

    // Clearing the new key must now leave nothing to fall back to.
    setLastSessionId("/proj", CLAUDE, "default", null);
    expect(getLastSessionId("/proj", CLAUDE, "default")).toBeNull();
  });
});
