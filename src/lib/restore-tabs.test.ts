import { describe, expect, test } from "bun:test";
import { resolveRestoredTabs } from "./restore-tabs";
import type { SessionLike } from "./session-label";

function session(id: string, title: string | null = null): SessionLike {
  return {
    id,
    custom_title: title,
    summary: null,
    first_message_preview: `first message of ${id}`,
  };
}

const PROXY = session("proxy-1", "Proxy");
const AI = session("ai-1", "ai-service");
const WORK = session("work-1", "workspaces");
const LANDING = session("landing-1", "landing");
const ALL = [PROXY, AI, WORK, LANDING];

describe("resolveRestoredTabs", () => {
  test("rebuilds the whole strip in its remembered order", () => {
    const out = resolveRestoredTabs(
      ["proxy-1", "ai-1", "work-1", "landing-1"],
      ALL,
      "ai-1",
    );
    expect(out.map((t) => t.sessionId)).toEqual([
      "proxy-1",
      "ai-1",
      "work-1",
      "landing-1",
    ]);
    expect(out.map((t) => t.label)).toEqual([
      "Proxy",
      "ai-service",
      "workspaces",
      "landing",
    ]);
  });

  test("labels come from the listing, not from storage — a rename while the app was closed shows up", () => {
    const renamed = [session("proxy-1", "Proxy v2")];
    const out = resolveRestoredTabs(["proxy-1"], renamed, "proxy-1");
    expect(out[0].label).toBe("Proxy v2");
  });

  test("a session that no longer exists is dropped, not restored", () => {
    const out = resolveRestoredTabs(
      ["proxy-1", "deleted-1", "work-1"],
      ALL,
      "proxy-1",
    );
    expect(out.map((t) => t.sessionId)).toEqual(["proxy-1", "work-1"]);
  });

  test("the woken session keeps its stored position", () => {
    const out = resolveRestoredTabs(["proxy-1", "ai-1"], ALL, "ai-1");
    expect(out[1].sessionId).toBe("ai-1");
  });

  test("a woken session missing from the stored list leads", () => {
    // Legacy `lastSessionId` from before workspaces were remembered, or a
    // tab correlated after the last write.
    const out = resolveRestoredTabs(["proxy-1"], ALL, "landing-1");
    expect(out.map((t) => t.sessionId)).toEqual(["landing-1", "proxy-1"]);
  });

  test("a woken session that no longer exists is not invented", () => {
    const out = resolveRestoredTabs(["proxy-1"], ALL, "deleted-1");
    expect(out.map((t) => t.sessionId)).toEqual(["proxy-1"]);
  });

  test("duplicate ids produce one tab", () => {
    const out = resolveRestoredTabs(["proxy-1", "proxy-1"], ALL, "proxy-1");
    expect(out).toHaveLength(1);
  });

  test("nothing remembered and nothing to wake restores nothing", () => {
    expect(resolveRestoredTabs([], ALL, null)).toEqual([]);
  });

  test("nothing remembered still restores the session to wake", () => {
    const out = resolveRestoredTabs([], ALL, "ai-1");
    expect(out).toEqual([{ sessionId: "ai-1", label: "ai-service" }]);
  });

  test("an empty listing restores nothing, however much is remembered", () => {
    expect(resolveRestoredTabs(["proxy-1", "ai-1"], [], "ai-1")).toEqual([]);
  });
});
