import { describe, expect, test } from "bun:test";
import { removeProjectTabs, type ClosableTab } from "./close-tabs";

function tabs(...specs: [id: string, projectPath: string][]): ClosableTab[] {
  return specs.map(([id, projectPath]) => ({ id, projectPath }));
}

describe("removeProjectTabs", () => {
  // The regression this exists for (#105): the project's tabs have to leave
  // together. If this ever returns a partial removal, the persistence effect
  // sees an intermediate strip and remembers a truncated workspace.
  test("removes every tab of the project at once", () => {
    const before = tabs(["a", "/p"], ["b", "/p"], ["c", "/p"]);
    const after = removeProjectTabs(before, "a", "/p");
    expect(after.tabs).toEqual([]);
  });

  test("leaves other projects' tabs untouched and in order", () => {
    const before = tabs(["a", "/p"], ["x", "/q"], ["b", "/p"], ["y", "/q"]);
    const after = removeProjectTabs(before, "x", "/p");
    expect(after.tabs.map((t) => t.id)).toEqual(["x", "y"]);
  });

  test("an active tab in the closed project pivots to null", () => {
    const before = tabs(["a", "/p"], ["b", "/p"]);
    expect(removeProjectTabs(before, "b", "/p").activeTabId).toBeNull();
  });

  test("an active tab in another project keeps the focus", () => {
    const before = tabs(["a", "/p"], ["x", "/q"]);
    expect(removeProjectTabs(before, "x", "/p").activeTabId).toBe("x");
  });

  test("no active tab stays no active tab", () => {
    const before = tabs(["a", "/p"]);
    expect(removeProjectTabs(before, null, "/p").activeTabId).toBeNull();
  });

  test("closing a project with no tabs changes nothing", () => {
    const before = tabs(["x", "/q"]);
    const after = removeProjectTabs(before, "x", "/p");
    expect(after.tabs.map((t) => t.id)).toEqual(["x"]);
    expect(after.activeTabId).toBe("x");
  });

  test("does not mutate the input", () => {
    const before = tabs(["a", "/p"], ["x", "/q"]);
    removeProjectTabs(before, "a", "/p");
    expect(before.map((t) => t.id)).toEqual(["a", "x"]);
  });

  // Paths are compared exactly, never by prefix — `/p` and `/p-old` are
  // different projects and a prefix test would close the wrong one.
  test("a project whose path merely prefixes another is not touched", () => {
    const before = tabs(["a", "/p"], ["b", "/p-old"], ["c", "/p/nested"]);
    const after = removeProjectTabs(before, null, "/p");
    expect(after.tabs.map((t) => t.id)).toEqual(["b", "c"]);
  });
});
