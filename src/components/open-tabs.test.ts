import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_REMEMBERED_TABS,
  getOpenTabIds,
  openTabsKey,
  preAgentOpenTabsKey,
  setOpenTabIds,
} from "./open-tabs";
import { CLAUDE, CURSOR } from "@/lib/agents";


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
    setOpenTabIds("/proj", CLAUDE, "default", ["a", "b", "c"]);
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual(["a", "b", "c"]);
  });

  test("default and custom profiles never see each other's workspace", () => {
    setOpenTabIds("/proj", CLAUDE, "default", ["a"]);
    setOpenTabIds("/proj", CLAUDE, "custom:abc123", ["b"]);

    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual(["a"]);
    expect(getOpenTabIds("/proj", CLAUDE, "custom:abc123")).toEqual(["b"]);
    expect(openTabsKey("/proj", CLAUDE, "default")).not.toBe(
      openTabsKey("/proj", CLAUDE, "custom:abc123"),
    );
  });

  test("an unwritten project reads as an empty workspace", () => {
    expect(getOpenTabIds("/never-opened", CLAUDE, "default")).toEqual([]);
  });

  test("the remembered list is capped", () => {
    const many = Array.from({ length: MAX_REMEMBERED_TABS + 5 }, (_, i) => `s${i}`);
    setOpenTabIds("/proj", CLAUDE, "default", many);
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toHaveLength(MAX_REMEMBERED_TABS);
    expect(getOpenTabIds("/proj", CLAUDE, "default")[0]).toBe("s0");
  });

  test("garbage in storage reads as empty instead of throwing", () => {
    localStorage.setItem(openTabsKey("/proj", CLAUDE, "default"), "{not json");
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual([]);

    localStorage.setItem(openTabsKey("/proj", CLAUDE, "default"), '"a string"');
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual([]);

    localStorage.setItem(openTabsKey("/proj", CLAUDE, "default"), '["a", 7, null, "b"]');
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual(["a", "b"]);
  });

  test("two agents on the same project keep separate workspaces", () => {
    setOpenTabIds("/proj", CLAUDE, "default", ["claude-a", "claude-b"]);
    setOpenTabIds("/proj", CURSOR, "default", ["cursor-a"]);

    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual([
      "claude-a",
      "claude-b",
    ]);
    expect(getOpenTabIds("/proj", CURSOR, "default")).toEqual(["cursor-a"]);
  });

  test("writing an empty list removes the key", () => {
    setOpenTabIds("/proj", CLAUDE, "default", ["a"]);
    setOpenTabIds("/proj", CLAUDE, "default", []);
    expect(localStorage.getItem(openTabsKey("/proj", CLAUDE, "default"))).toBeNull();
  });
});

// See `last-session.test.ts` — every pre-agent key was Claude's, and the
// migration has to be a one-time move rather than a copy that leaves the old
// spelling able to come back.
describe("pre-agent key migration", () => {
  test("an upgraded install restores the workspace it had, once", () => {
    localStorage.setItem(
      preAgentOpenTabsKey("/proj", "default"),
      JSON.stringify(["a", "b", "c"]),
    );

    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual(["a", "b", "c"]);
    expect(
      localStorage.getItem(preAgentOpenTabsKey("/proj", "default")),
    ).toBeNull();
    // Still there on the second read, now from the new key alone.
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual(["a", "b", "c"]);
  });

  test("order survives the migration", () => {
    localStorage.setItem(
      preAgentOpenTabsKey("/proj", "default"),
      JSON.stringify(["z", "m", "a"]),
    );
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual(["z", "m", "a"]);
  });

  test("another agent never adopts Claude's pre-agent workspace", () => {
    localStorage.setItem(
      preAgentOpenTabsKey("/proj", "default"),
      JSON.stringify(["a"]),
    );

    expect(getOpenTabIds("/proj", CURSOR, "default")).toEqual([]);
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual(["a"]);
  });

  test("the new key wins when both exist", () => {
    localStorage.setItem(
      preAgentOpenTabsKey("/proj", "default"),
      JSON.stringify(["old"]),
    );
    setOpenTabIds("/proj", CLAUDE, "default", ["new"]);

    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual(["new"]);
  });

  test("a write retires the old spelling so it cannot resurrect", () => {
    localStorage.setItem(
      preAgentOpenTabsKey("/proj", "default"),
      JSON.stringify(["old"]),
    );
    setOpenTabIds("/proj", CLAUDE, "default", ["new"]);
    expect(
      localStorage.getItem(preAgentOpenTabsKey("/proj", "default")),
    ).toBeNull();

    setOpenTabIds("/proj", CLAUDE, "default", []);
    expect(getOpenTabIds("/proj", CLAUDE, "default")).toEqual([]);
  });
});
