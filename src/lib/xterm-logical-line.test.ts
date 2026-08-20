import { describe, expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import {
  cellRange,
  rangeSpansRow,
  readLogicalLine,
} from "@/lib/xterm-logical-line";

/** A buffer of fixed-width rows. `rows[i].wrapped` mirrors xterm's
 *  `isWrapped`: true when the row is a continuation of the one above. */
function fakeTerm(
  cols: number,
  rows: { text: string; wrapped?: boolean }[],
): Terminal {
  const lines = rows.map((r) => ({
    length: cols,
    isWrapped: !!r.wrapped,
    getCell(i: number) {
      const ch = r.text[i];
      return { getChars: () => (ch === undefined ? "" : ch) };
    },
  }));
  return {
    buffer: { active: { getLine: (y: number) => lines[y] } },
  } as unknown as Terminal;
}

/** Split `s` into `cols`-wide rows, the first a start and the rest wrapped —
 *  which is exactly what xterm does to a line too long to fit. */
function wrapped(s: string, cols: number) {
  const rows: { text: string; wrapped?: boolean }[] = [];
  for (let i = 0; i < s.length; i += cols) {
    rows.push({ text: s.slice(i, i + cols), wrapped: i > 0 });
  }
  return rows;
}

describe("readLogicalLine", () => {
  test("an unwrapped row is returned on its own, padded to width", () => {
    const term = fakeTerm(10, [{ text: "hola" }, { text: "chau" }]);
    const got = readLogicalLine(term, 1)!;
    expect(got.text).toBe("hola      ");
    expect(got.startY).toBe(1);
    expect(got.rows).toBe(1);
  });

  test("wrapped rows are joined back into one line", () => {
    const path = "/private/tmp/claude-501/proyecto/scratchpad/test-note.md";
    const term = fakeTerm(20, wrapped(path, 20));
    const got = readLogicalLine(term, 1)!;
    expect(got.text.trimEnd()).toBe(path);
    expect(got.rows).toBe(3);
  });

  test("reading from a continuation row finds the whole line", () => {
    // The case that matters: the pointer is over the second half of a
    // wrapped path, and the link has to be found from there too.
    const path = "/private/tmp/claude-501/proyecto/scratchpad/test-note.md";
    const term = fakeTerm(20, wrapped(path, 20));
    const got = readLogicalLine(term, 3)!;
    expect(got.text.trimEnd()).toBe(path);
    expect(got.startY).toBe(1);
  });

  test("a following unwrapped row is not swallowed", () => {
    const term = fakeTerm(4, [
      { text: "abcd" },
      { text: "ef  ", wrapped: true },
      { text: "next" },
    ]);
    const got = readLogicalLine(term, 1)!;
    expect(got.text).toBe("abcdef  ");
    expect(got.rows).toBe(2);
  });

  test("a multi-code-unit grapheme still occupies exactly one cell", () => {
    // An emoji is two JS code units held in one cell (and its second cell is
    // empty). Letting it contribute two characters would slide every offset
    // after it onto the wrong cell — and, once lines are joined, onto the
    // wrong row. Both cells become spaces instead.
    const cells = ["🎉", "", "a", "b", "c", "d"];
    const term = {
      buffer: {
        active: {
          getLine: () => ({
            length: cells.length,
            isWrapped: false,
            getCell: (i: number) => ({ getChars: () => cells[i] ?? "" }),
          }),
        },
      },
    } as unknown as Terminal;
    expect(readLogicalLine(term, 1)!.text).toBe("  abcd");
  });

  test("a missing line yields nothing rather than throwing", () => {
    const term = fakeTerm(4, [{ text: "abcd" }]);
    expect(readLogicalLine(term, 9)).toBeNull();
  });
});

describe("cellRange", () => {
  const logical = { text: "", startY: 5, rows: 3, cols: 10 };

  test("a match inside one row stays on that row", () => {
    expect(cellRange(logical, 2, 3)).toEqual({
      start: { x: 3, y: 5 },
      end: { x: 5, y: 5 },
    });
  });

  test("a match crossing a wrap spans two rows", () => {
    // Offsets 8..11 -> cells 9,10 of row 5 and cells 1,2 of row 6.
    expect(cellRange(logical, 8, 4)).toEqual({
      start: { x: 9, y: 5 },
      end: { x: 2, y: 6 },
    });
  });

  test("a match landing exactly on a row boundary", () => {
    expect(cellRange(logical, 10, 10)).toEqual({
      start: { x: 1, y: 6 },
      end: { x: 10, y: 6 },
    });
  });
});

describe("rangeSpansRow", () => {
  const range = { start: { y: 5 }, end: { y: 7 } };

  test("covers every row it crosses, and nothing else", () => {
    expect(rangeSpansRow(range, 4)).toBe(false);
    expect(rangeSpansRow(range, 5)).toBe(true);
    expect(rangeSpansRow(range, 6)).toBe(true);
    expect(rangeSpansRow(range, 7)).toBe(true);
    expect(rangeSpansRow(range, 8)).toBe(false);
  });
});
