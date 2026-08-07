import { describe, expect, test } from "bun:test";
import { resolveAutoResumeTarget, type AutoResumeDeps } from "./auto-resume";

const SESSION = {
  id: "abc-123",
  custom_title: null,
  summary: null,
  first_message_preview: "hello there",
};

function deps(overrides: Partial<AutoResumeDeps> = {}): AutoResumeDeps {
  return {
    getNamespaced: () => null,
    getLegacy: () => null,
    listSessions: async () => [],
    ...overrides,
  };
}

describe("resolveAutoResumeTarget", () => {
  test("valid namespaced id resolves to open from namespaced", async () => {
    const decision = await resolveAutoResumeTarget(
      "default",
      deps({
        getNamespaced: () => SESSION.id,
        listSessions: async () => [SESSION],
      }),
    );
    expect(decision).toEqual({
      action: "open",
      source: "namespaced",
      sessionId: SESSION.id,
      label: "hello there",
    });
  });

  test("stale namespaced id clears only the namespaced pointer", async () => {
    const decision = await resolveAutoResumeTarget(
      "default",
      deps({
        getNamespaced: () => "gone-session",
        listSessions: async () => [SESSION],
      }),
    );
    expect(decision).toEqual({ action: "stale", source: "namespaced" });
  });

  test("valid default legacy id migrates then opens", async () => {
    const decision = await resolveAutoResumeTarget(
      "default",
      deps({
        getNamespaced: () => null,
        getLegacy: () => SESSION.id,
        listSessions: async () => [SESSION],
      }),
    );
    expect(decision).toEqual({
      action: "open",
      source: "legacy",
      sessionId: SESSION.id,
      label: "hello there",
    });
  });

  test("stale default legacy id clears only the legacy pointer", async () => {
    const decision = await resolveAutoResumeTarget(
      "default",
      deps({
        getNamespaced: () => null,
        getLegacy: () => "gone-session",
        listSessions: async () => [SESSION],
      }),
    );
    expect(decision).toEqual({ action: "stale", source: "legacy" });
  });

  test("session-listing error aborts and preserves every stored pointer", async () => {
    const decision = await resolveAutoResumeTarget(
      "default",
      deps({
        getNamespaced: () => SESSION.id,
        getLegacy: () => "also-here",
        listSessions: async () => {
          throw new Error("direnv blocked");
        },
      }),
    );
    expect(decision).toEqual({ action: "none" });
  });

  test("custom profile never reads the legacy key", async () => {
    let legacyReads = 0;
    const decision = await resolveAutoResumeTarget(
      "custom:xyz",
      deps({
        getNamespaced: () => null,
        getLegacy: () => {
          legacyReads += 1;
          return SESSION.id;
        },
        listSessions: async () => [SESSION],
      }),
    );
    expect(legacyReads).toBe(0);
    expect(decision).toEqual({ action: "none" });
  });

  test("nothing stored for either pointer resolves to none", async () => {
    const decision = await resolveAutoResumeTarget("default", deps());
    expect(decision).toEqual({ action: "none" });
  });
});
