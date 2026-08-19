import { describe, expect, test } from "bun:test";
import { describeClip, previewOf } from "@/lib/clipboard-prefs";

describe("previewOf", () => {
  test("collapses a multi-line clip into one readable row", () => {
    // Without the newline marker the row would show only "line one" and the
    // user could not tell two different clips apart.
    expect(previewOf("line one\nline two")).toBe("line one ⏎ line two");
  });

  test("squeezes runs of whitespace", () => {
    expect(previewOf("a     b\t\tc")).toBe("a b c");
  });

  test("trims and ellipsizes past the cap", () => {
    const out = previewOf("x".repeat(200));
    expect(out.length).toBe(141);
    expect(out.endsWith("…")).toBe(true);
  });

  test("leaves a short single-line clip alone", () => {
    expect(previewOf("hello@example.com")).toBe("hello@example.com");
  });
});

describe("describeClip", () => {
  test("a one-line clip reports only its size", () => {
    expect(describeClip("hello")).toBe("5 B");
  });

  test("a multi-line clip reports its line count too", () => {
    expect(describeClip("a\nb\nc")).toBe("3 lines · 5 B");
  });

  test("sizes are measured in bytes, not characters", () => {
    // "á" is two bytes in UTF-8 — a length-based count would say 1 B.
    expect(describeClip("á")).toBe("2 B");
  });

  test("scales to KB and MB", () => {
    expect(describeClip("x".repeat(2048))).toBe("2.0 KB");
    expect(describeClip("x".repeat(2 * 1024 * 1024))).toBe("2.0 MB");
  });
});
