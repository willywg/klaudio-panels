import { describe, expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import {
  cellRange,
  rangeSpansRow,
  readLogicalLine,
  type LogicalLine,
} from "@/lib/xterm-logical-line";

/** A buffer of fixed-width rows. `wrapped` mirrors xterm's `isWrapped`: true
 *  when the row continues the one above because the terminal ran out of
 *  width. Rows are padded to `cols`, as xterm's cells are. */
function fakeTerm(
  cols: number,
  rows: { text: string; wrapped?: boolean }[],
): Terminal {
  const lines = rows.map((r) => {
    const padded = r.text.padEnd(cols, " ");
    return {
      length: cols,
      isWrapped: !!r.wrapped,
      getCell: (i: number) => ({ getChars: () => padded[i] ?? "" }),
    };
  });
  return {
    buffer: { active: { getLine: (y: number) => lines[y] } },
  } as unknown as Terminal;
}

/** Split `s` into `cols`-wide rows flagged as xterm wraps. */
function xtermWrapped(s: string, cols: number) {
  const rows: { text: string; wrapped?: boolean }[] = [];
  for (let i = 0; i < s.length; i += cols) {
    rows.push({ text: s.slice(i, i + cols), wrapped: i > 0 });
  }
  return rows;
}

describe("xterm's own wrap", () => {
  const path = "/private/tmp/claude-501/proyecto/scratchpad/test-note.md";

  test("continuation rows are joined back into one line", () => {
    const got = readLogicalLine(fakeTerm(20, xtermWrapped(path, 20)), 1)!;
    expect(got.text.trimEnd()).toBe(path);
    expect(got.segments).toHaveLength(3);
  });

  test("reading from a continuation row finds the whole line", () => {
    // The pointer can be over the tail of a wrapped path and the link still
    // has to be found from there.
    const got = readLogicalLine(fakeTerm(20, xtermWrapped(path, 20)), 3)!;
    expect(got.text.trimEnd()).toBe(path);
    expect(got.segments[0].y).toBe(1);
  });

  test("a following unwrapped row is not swallowed", () => {
    const term = fakeTerm(4, [
      { text: "abcd" },
      { text: "ef", wrapped: true },
      { text: "next" },
    ]);
    const got = readLogicalLine(term, 1)!;
    expect(got.text).toBe("abcdef  ");
    expect(got.segments).toHaveLength(2);
  });
});

describe("Ink's wrap (hanging indent, real newline)", () => {
  // What Claude's TUI actually emits: the path is hard-broken at the pane
  // edge and continues at the list item's indent, as its own buffer line.
  // Nothing marks these as related — `isWrapped` is false (#87).
  const COLS = 40;
  const inkRows = [
    { text: "  - /Users/willywg/.claude/memory/test-" },
    { text: "    note-2026-08-20.md" },
  ];

  test("a hard-broken token is stitched across the indent", () => {
    const got = readLogicalLine(fakeTerm(COLS, inkRows), 1)!;
    expect(got.text).toContain(
      "/Users/willywg/.claude/memory/test-note-2026-08-20.md",
    );
  });

  test("stitching works from the continuation row too", () => {
    const got = readLogicalLine(fakeTerm(COLS, inkRows), 2)!;
    expect(got.text).toContain(
      "/Users/willywg/.claude/memory/test-note-2026-08-20.md",
    );
    expect(got.segments[0].y).toBe(1);
  });

  test("the stripped indent is recorded, so offsets still map to cells", () => {
    const got = readLogicalLine(fakeTerm(COLS, inkRows), 1)!;
    expect(got.segments[1].x).toBe(4);
    // The seam: last *content* cell of row 1 (its 39 characters stop one
    // short of the edge, and that pad was dropped) and the first content
    // cell of row 2, past the stripped indent.
    const seam = got.segments[1].offset;
    expect(cellRange(got, seam - 1, 2)).toEqual({
      start: { x: 39, y: 1 },
      end: { x: 5, y: 2 },
    });
  });

  test("an indented line after a line with room to spare is left alone", () => {
    // Room left at the edge means the renderer chose to break there, so the
    // next line is a new thought and not a continuation.
    const term = fakeTerm(COLS, [
      { text: "  - /Users/willywg/notes.md" },
      { text: "    otra/cosa.md" },
    ]);
    const got = readLogicalLine(term, 1)!;
    expect(got.segments).toHaveLength(1);
  });

  test("an unindented full-width line is left alone", () => {
    // No hanging indent, so this is ordinary flowing text.
    const term = fakeTerm(10, [{ text: "abcdefghij" }, { text: "klmno" }]);
    expect(readLogicalLine(term, 1)!.segments).toHaveLength(1);
  });

  test("a seam that isn't token-shaped is left alone", () => {
    const term = fakeTerm(10, [{ text: "texto que" }, { text: "  (nota)" }]);
    expect(readLogicalLine(term, 1)!.segments).toHaveLength(1);
  });
});

describe("readLogicalLine edges", () => {
  test("a multi-code-unit grapheme still occupies exactly one cell", () => {
    // An emoji is two code units in one cell, and its second cell is empty.
    // Contributing two characters for one cell would slide every later
    // offset onto the wrong cell — and, once rows are joined, the wrong row.
    const cells = ["🎉", "", "a", "b", "c", "d"];
    const line = {
      length: cells.length,
      isWrapped: false,
      getCell: (i: number) => ({ getChars: () => cells[i] ?? "" }),
    };
    const term = {
      buffer: { active: { getLine: (y: number) => (y === 0 ? line : undefined) } },
    } as unknown as Terminal;
    expect(readLogicalLine(term, 1)!.text).toBe("  abcd");
  });

  test("a missing line yields nothing rather than throwing", () => {
    expect(readLogicalLine(fakeTerm(4, [{ text: "abcd" }]), 9)).toBeNull();
  });
});

describe("cellRange", () => {
  // Two rows of 10 cells, the second having had a 3-cell indent stripped.
  const logical: LogicalLine = {
    text: "0123456789abcdefg",
    segments: [
      { offset: 0, y: 5, x: 0, len: 10 },
      { offset: 10, y: 6, x: 3, len: 7 },
    ],
  };

  test("a match inside one row stays on that row", () => {
    expect(cellRange(logical, 2, 3)).toEqual({
      start: { x: 3, y: 5 },
      end: { x: 5, y: 5 },
    });
  });

  test("a match crossing the seam spans two rows, past the indent", () => {
    expect(cellRange(logical, 8, 4)).toEqual({
      start: { x: 9, y: 5 },
      end: { x: 5, y: 6 },
    });
  });
});

describe("rangeSpansRow", () => {
  const range = { start: { y: 5 }, end: { y: 7 } };

  test("covers every row it crosses, and nothing else", () => {
    expect(rangeSpansRow(range, 4)).toBe(false);
    expect(rangeSpansRow(range, 5)).toBe(true);
    expect(rangeSpansRow(range, 7)).toBe(true);
    expect(rangeSpansRow(range, 8)).toBe(false);
  });
});
