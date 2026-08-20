import type { IBufferLine, Terminal } from "@xterm/xterm";

/** A logical line: one buffer row, plus every row it wrapped onto.
 *
 *  xterm stores a long line as N rows of exactly `cols` cells each, with the
 *  continuations flagged `isWrapped`. A link provider is asked about one row
 *  at a time, so reading that row alone sees a *fragment* — which is how a
 *  path like `/private/tmp/claude-501/…/scratchpad/notes.md` became
 *  `/private/tmp/claude-501/-Users-willywg-proyectos-pet-projects-ch` plus a
 *  dangling `asqui/…`, and clicking it opened nothing (#87). */
export type LogicalLine = {
  /** Every row concatenated, unpadded and untrimmed so an offset into this
   *  string maps to a cell by plain division. */
  text: string;
  /** 1-based buffer line number of the group's first row. */
  startY: number;
  rows: number;
  /** Cells per row — the stride for mapping an offset back to a cell. */
  cols: number;
};

/** Ceiling on rows joined in either direction. A token spanning more than a
 *  screenful of wrapping is not a path or a URL, and walking an entire pasted
 *  blob on every hover would be paid on every mouse move. */
const MAX_ROWS = 24;

/** Read the whole logical line that `bufferLineNumber` (1-based) belongs to.
 *
 *  Works from any row of the group, not just the first: the mouse can be over
 *  the second half of a wrapped path and must still find the link. */
export function readLogicalLine(
  term: Terminal,
  bufferLineNumber: number,
): LogicalLine | null {
  const buf = term.buffer.active;
  const first = buf.getLine(bufferLineNumber - 1);
  if (!first) return null;

  // Walk back to the row that started the wrap. Bounded: hitting the cap
  // just means we treat a continuation row as a start, which costs at most
  // the one token straddling the cut.
  let startIdx = bufferLineNumber - 1;
  let back = 0;
  while (startIdx > 0 && back < MAX_ROWS) {
    const line = buf.getLine(startIdx);
    if (!line?.isWrapped) break;
    startIdx--;
    back++;
  }

  let text = "";
  let rows = 0;
  for (let idx = startIdx; rows < MAX_ROWS; idx++) {
    const line = buf.getLine(idx);
    if (!line) break;
    if (idx > startIdx && !line.isWrapped) break;
    text += stringifyRow(line);
    rows++;
  }

  return { text, startY: startIdx + 1, rows, cols: first.length };
}

/** The cell range covering `text.slice(offset, offset + length)`.
 *
 *  Start and end can land on different rows; xterm's `ILinkRange` takes that
 *  and underlines across the wrap, which is also what makes the whole path
 *  highlight as one link instead of two. */
export function cellRange(
  logical: LogicalLine,
  offset: number,
  length: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const last = offset + Math.max(1, length) - 1;
  return {
    start: {
      x: (offset % logical.cols) + 1,
      y: logical.startY + Math.floor(offset / logical.cols),
    },
    end: {
      x: (last % logical.cols) + 1,
      y: logical.startY + Math.floor(last / logical.cols),
    },
  };
}

/** True when a range touches the row the provider was asked about. Providers
 *  must filter on this: a match on row 1 of a group is not a link the user can
 *  hover from row 2 unless we say so, and returning every match for every row
 *  would register the same link several times. */
export function rangeSpansRow(
  range: { start: { y: number }; end: { y: number } },
  bufferLineNumber: number,
): boolean {
  return range.start.y <= bufferLineNumber && bufferLineNumber <= range.end.y;
}

/** One row's cells as text: exactly one character per cell.
 *
 *  Both invariants here exist to keep an offset in `text` mapping to a cell by
 *  division, which is what the multi-row range math rests on:
 *
 *  - **Not trimmed.** A trailing-space trim would shorten a row and slide
 *    every later offset. Trailing spaces cost nothing since neither a path nor
 *    a URL can contain one.
 *  - **One char per cell.** A cell holding a grapheme that isn't a single code
 *    unit — an emoji surrogate pair, a combining sequence — becomes a space
 *    rather than contributing two characters to one cell. Nothing is lost:
 *    both regexes match on ASCII `\w`, so such a character could never be part
 *    of a token anyway. The second cell of a double-width character is empty
 *    and becomes a space too, which is what keeps its width honest. */
function stringifyRow(line: IBufferLine): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const chars = line.getCell(i)?.getChars() ?? "";
    out += chars.length === 1 ? chars : " ";
  }
  return out;
}
