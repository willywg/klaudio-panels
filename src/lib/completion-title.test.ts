import { describe, expect, test } from "bun:test";
import { completionTitle } from "./completion-title";

describe("completion title", () => {
  test("names the agent that finished", () => {
    expect(completionTitle("klaudio-panels", "claude")).toBe(
      "klaudio-panels · Claude is done",
    );
    expect(completionTitle("klaudio-panels", "cursor")).toBe(
      "klaudio-panels · Cursor is done",
    );
  });
});
