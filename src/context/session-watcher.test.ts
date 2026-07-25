import { describe, expect, test } from "bun:test";
import { findPromotionCandidate, shouldApplySessionMeta } from "./session-watcher";
import type { TerminalTab } from "./terminal";

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "tab-1",
    projectPath: "/replace",
    sessionId: null,
    profileId: "default",
    label: "New session",
    status: "opening",
    exitCode: null,
    error: null,
    spawnedAt: 1_000,
    needsAttention: false,
    statusBarOverlayInstalled: false,
    ...overrides,
  };
}

describe("findPromotionCandidate", () => {
  test("promotes a matching pending default-profile tab", () => {
    const tab = makeTab({ profileId: "default" });
    const found = findPromotionCandidate([tab], {
      project_path: "/replace",
      jsonl_created_at_ms: 1_500,
    });
    expect(found?.id).toBe(tab.id);
  });

  test("never promotes a matching pending custom-profile tab — the backend watcher only observes the default root", () => {
    const tab = makeTab({ profileId: "custom:abc123" });
    const found = findPromotionCandidate([tab], {
      project_path: "/replace",
      jsonl_created_at_ms: 1_500,
    });
    expect(found).toBeUndefined();
  });

  test("still respects the existing project-path / pending / timing filters for default tabs", () => {
    const wrongProject = makeTab({ id: "a", projectPath: "/other" });
    const alreadyResolved = makeTab({ id: "b", sessionId: "already-set" });
    const tooOld = makeTab({ id: "c", spawnedAt: 100_000 });
    const good = makeTab({ id: "d", spawnedAt: 1_000 });

    const found = findPromotionCandidate(
      [wrongProject, alreadyResolved, tooOld, good],
      { project_path: "/replace", jsonl_created_at_ms: 1_500 },
    );
    expect(found?.id).toBe("d");
  });
});

describe("shouldApplySessionMeta", () => {
  test("true for a default-profile tab", () => {
    expect(shouldApplySessionMeta(makeTab({ profileId: "default" }))).toBe(true);
  });

  test("false for a custom-profile tab", () => {
    expect(shouldApplySessionMeta(makeTab({ profileId: "custom:abc123" }))).toBe(
      false,
    );
  });

  test("false when no tab was found", () => {
    expect(shouldApplySessionMeta(undefined)).toBe(false);
  });
});
