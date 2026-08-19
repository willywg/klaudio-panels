import { describe, expect, test } from "bun:test";
import { applyClip, type ClipEntry } from "@/context/clipboard-history";

function clip(id: number, text: string): ClipEntry {
  return { id, text, copied_at_ms: id * 1000, truncated: false };
}

describe("applyClip", () => {
  test("newest clip lands first", () => {
    const out = applyClip([clip(1, "first")], clip(2, "second"));
    expect(out.map((e) => e.text)).toEqual(["second", "first"]);
  });

  test("re-copying something already held promotes it", () => {
    // Otherwise the 10-entry window fills with repeats of one clip and the
    // older distinct ones fall off for nothing.
    const list = [clip(3, "c"), clip(2, "b"), clip(1, "a")];
    const out = applyClip(list, clip(4, "a"));
    expect(out.map((e) => e.text)).toEqual(["a", "c", "b"]);
    expect(out[0].id).toBe(4);
  });

  test("caps at ten, dropping the oldest", () => {
    let list: ClipEntry[] = [];
    for (let i = 1; i <= 13; i++) list = applyClip(list, clip(i, `e${i}`));
    expect(list.length).toBe(10);
    expect(list[0].text).toBe("e13");
    expect(list[9].text).toBe("e4");
  });

  test("matches on text, so identical text from a new copy is one row", () => {
    const out = applyClip([clip(1, "same")], clip(2, "same"));
    expect(out.length).toBe(1);
    expect(out[0].id).toBe(2);
  });
});
