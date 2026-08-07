import { describe, expect, test } from "bun:test";
import { resolveCompleteTabId } from "./notifications";
import type { TerminalTab } from "./terminal";

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "tab-1",
    projectPath: "/replace",
    sessionId: "session-1",
    profileId: "default",
    label: "session-1",
    status: "running",
    exitCode: null,
    error: null,
    spawnedAt: 1_000,
    needsAttention: false,
    ...overrides,
  };
}

describe("resolveCompleteTabId", () => {
  // session:complete is emitted only by the default-root-only backend
  // watcher (session_watcher.rs) — it must never be able to mutate a
  // custom-profile tab's attention/toast routing, even on an exact
  // project-path + session-id match.
  test("session:complete cannot update a custom-profile tab", () => {
    const tab = makeTab({ profileId: "custom:abc123" });
    const tabId = resolveCompleteTabId([tab], "/replace", "session-1");
    expect(tabId).toBeNull();
  });

  test("session:complete continues to work for a default-profile tab", () => {
    const tab = makeTab({ profileId: "default" });
    const tabId = resolveCompleteTabId([tab], "/replace", "session-1");
    expect(tabId).toBe(tab.id);
  });

  test("no match when sessionId is missing (older warp builds)", () => {
    const tab = makeTab();
    expect(resolveCompleteTabId([tab], "/replace", null)).toBeNull();
  });

  test("no match when project path or session id differ", () => {
    const tab = makeTab();
    expect(resolveCompleteTabId([tab], "/other", "session-1")).toBeNull();
    expect(resolveCompleteTabId([tab], "/replace", "other-session")).toBeNull();
  });
});
