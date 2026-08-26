import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_REMEMBERED_TABS,
  getOpenTabIds,
  openTabsKey,
  setOpenTabIds,
} from "./open-tabs";

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

describe("open-tabs", () => {
  test("round-trips the workspace in order", () => {
    setOpenTabIds("/proj", "default", ["a", "b", "c"]);
    expect(getOpenTabIds("/proj", "default")).toEqual(["a", "b", "c"]);
  });

  test("default and custom profiles never see each other's workspace", () => {
    setOpenTabIds("/proj", "default", ["a"]);
    setOpenTabIds("/proj", "custom:abc123", ["b"]);

    expect(getOpenTabIds("/proj", "default")).toEqual(["a"]);
    expect(getOpenTabIds("/proj", "custom:abc123")).toEqual(["b"]);
    expect(openTabsKey("/proj", "default")).not.toBe(
      openTabsKey("/proj", "custom:abc123"),
    );
  });

  test("an unwritten project reads as an empty workspace", () => {
    expect(getOpenTabIds("/never-opened", "default")).toEqual([]);
  });

  test("the remembered list is capped", () => {
    const many = Array.from({ length: MAX_REMEMBERED_TABS + 5 }, (_, i) => `s${i}`);
    setOpenTabIds("/proj", "default", many);
    expect(getOpenTabIds("/proj", "default")).toHaveLength(MAX_REMEMBERED_TABS);
    expect(getOpenTabIds("/proj", "default")[0]).toBe("s0");
  });

  test("garbage in storage reads as empty instead of throwing", () => {
    localStorage.setItem(openTabsKey("/proj", "default"), "{not json");
    expect(getOpenTabIds("/proj", "default")).toEqual([]);

    localStorage.setItem(openTabsKey("/proj", "default"), '"a string"');
    expect(getOpenTabIds("/proj", "default")).toEqual([]);

    localStorage.setItem(openTabsKey("/proj", "default"), '["a", 7, null, "b"]');
    expect(getOpenTabIds("/proj", "default")).toEqual(["a", "b"]);
  });

  test("writing an empty list removes the key", () => {
    setOpenTabIds("/proj", "default", ["a"]);
    setOpenTabIds("/proj", "default", []);
    expect(localStorage.getItem(openTabsKey("/proj", "default"))).toBeNull();
  });
});
