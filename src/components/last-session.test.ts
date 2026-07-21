import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearLegacyLastSessionId,
  getLastSessionId,
  getLegacyLastSessionId,
  legacyLastSessionKey,
  setLastSessionId,
} from "./last-session";

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
    setLastSessionId("/proj", "default", "tina-session");
    setLastSessionId("/proj", "custom:abc123", "replace-session");

    expect(getLastSessionId("/proj", "default")).toBe("tina-session");
    expect(getLastSessionId("/proj", "custom:abc123")).toBe("replace-session");
  });

  test("clearing one profile's key does not touch the other's", () => {
    setLastSessionId("/proj", "default", "tina-session");
    setLastSessionId("/proj", "custom:abc123", "replace-session");

    setLastSessionId("/proj", "default", null);

    expect(getLastSessionId("/proj", "default")).toBeNull();
    expect(getLastSessionId("/proj", "custom:abc123")).toBe("replace-session");
  });

  test("the namespaced getter never falls back to the legacy key", () => {
    localStorage.setItem(legacyLastSessionKey("/proj"), "old-tina-session");

    expect(getLastSessionId("/proj", "default")).toBeNull();
    expect(getLastSessionId("/proj", "custom:abc123")).toBeNull();
  });

  test("legacy pointer is readable and clearable independently", () => {
    localStorage.setItem(legacyLastSessionKey("/proj"), "old-tina-session");

    expect(getLegacyLastSessionId("/proj")).toBe("old-tina-session");
    clearLegacyLastSessionId("/proj");
    expect(getLegacyLastSessionId("/proj")).toBeNull();
  });
});
