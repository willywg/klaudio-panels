import type { IBufferLine, Terminal } from "@xterm/xterm";
import { debugLog } from "@/lib/debug-log";

/** One row's contribution to a logical line: where its text starts in the
 *  joined string, and which cell that maps back to. `x` is non-zero when a
 *  continuation row's indent was stripped. */
export type Segment = {
  offset: number;
  /** 1-based buffer line number. */
  y: number;
  /** 0-based cell index this segment starts at. */
  x: number;
  len: number;
};

/** A logical line: a row plus every row its text continued onto.
 *
 *  Two different things break a long line, and a link has to survive both:
 *
 *  - **xterm's wrap.** A line too wide for the terminal is stored as N rows of
 *    exactly `cols` cells, continuations flagged `isWrapped`. Continuation
 *    starts at column 1.
 *  - **Ink's wrap.** Claude's TUI lays out its own text and emits real
 *    newlines, so a path too long for the pane is hard-broken at the edge and
 *    continues at the block's hanging indent. To xterm these are ordinary
 *    separate lines — `isWrapped` is false, and nothing in the buffer says
 *    they belong together (#87).
 *
 *  Reading a single row sees a fragment of either: the head opens a path that
 *  doesn't exist, and the tail gets matched as a bare filename and hunted for
 *  inside the project. */
export type LogicalLine = {
  /** Every row's contribution concatenated, indents stripped. */
  text: string;
  segments: Segment[];
};

/** Ceiling on rows joined in either direction. A token spanning more than a
 *  screenful is not a path, and walking a pasted blob on every hover would be
 *  paid on every mouse move. */
const MAX_ROWS = 24;

/** Characters that can sit either side of a hard-broken token. Deliberately
 *  the union of what both link regexes accept, minus the delimiters — a break
 *  between two of these is the only kind worth stitching. */
const TOKEN_CHAR = /[\w.@/:%?#=&+~-]/;

/** How close to the right edge counts as "the renderer ran out of room".
 *  Exactly the last cell is the normal case; one short of it tolerates a
 *  renderer that keeps a column in reserve. */
const EDGE_SLACK = 1;

export function readLogicalLine(
  term: Terminal,
  bufferLineNumber: number,
): LogicalLine | null {
  const buf = term.buffer.active;
  if (!buf.getLine(bufferLineNumber - 1)) return null;

  // Walk back to the row the text started on. Bounded: hitting the cap just
  // means we treat a continuation as a start, costing the one token that
  // straddles the cut.
  let startIdx = bufferLineNumber - 1;
  for (let back = 0; back < MAX_ROWS && startIdx > 0; back++) {
    const cur = buf.getLine(startIdx);
    const prev = buf.getLine(startIdx - 1);
    if (!cur || !prev) break;
    if (cur.isWrapped) {
      startIdx--;
      continue;
    }
    if (!continuesSoftly(rowText(prev), rowText(cur))) break;
    startIdx--;
  }

  const segments: Segment[] = [];
  let text = "";
  let prevText: string | null = null;
  for (let idx = startIdx; segments.length < MAX_ROWS; idx++) {
    const line = buf.getLine(idx);
    if (!line) break;
    const t = rowText(line);
    let x = 0;
    if (idx > startIdx) {
      if (line.isWrapped) {
        x = 0;
      } else if (prevText !== null && continuesSoftly(prevText, t)) {
        x = indentOf(t);
        // Drop the previous row's trailing padding — with EDGE_SLACK a token
        // can stop one cell short of the edge, and that pad space would sit
        // in the middle of the stitched token and break it apart again.
        const trimmed = text.replace(/ +$/, "");
        const dropped = text.length - trimmed.length;
        if (dropped > 0) {
          text = trimmed;
          segments[segments.length - 1].len -= dropped;
        }
        logSoftJoin(prevText, t, idx + 1);
      } else {
        break;
      }
    }
    segments.push({ offset: text.length, y: idx + 1, x, len: t.length - x });
    text += t.slice(x);
    prevText = t;
  }

  return { text, segments };
}

/** True when `cur` looks like the continuation of a token `prev` ran out of
 *  room for: `prev` reaches the right edge, `cur` is indented, and the
 *  characters meeting at the seam could both belong to one token.
 *
 *  The residual false positive is a line whose last word happens to end
 *  exactly at the edge followed by an indented line starting with a word —
 *  the two get glued, and a link at the very start of that second line is
 *  lost. It needs the wrap to land on the edge to the character, and the
 *  alternative (never stitching) means every long path Claude prints is
 *  unclickable, which is the complaint this exists to answer. */
function continuesSoftly(prev: string, cur: string): boolean {
  const lastIdx = lastNonBlankIndex(prev);
  if (lastIdx < prev.length - 1 - EDGE_SLACK) return false;
  const indent = indentOf(cur);
  // No indent means an ordinary new line, not a hanging continuation.
  if (indent <= 0) return false;
  return TOKEN_CHAR.test(prev[lastIdx]) && TOKEN_CHAR.test(cur[indent]);
}

/** The cell range covering `text.slice(offset, offset + length)`.
 *
 *  Start and end can land on different rows; xterm's `ILinkRange` takes that
 *  and underlines across the break, so the whole path highlights as one link
 *  rather than two. */
export function cellRange(
  logical: LogicalLine,
  offset: number,
  length: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  return {
    start: cellAt(logical, offset),
    end: cellAt(logical, offset + Math.max(1, length) - 1),
  };
}

/** True when a range touches the row the provider was asked about. Providers
 *  must filter on this: every row of a group produces the same match list, so
 *  without it one link would register once per row it crosses. */
export function rangeSpansRow(
  range: { start: { y: number }; end: { y: number } },
  bufferLineNumber: number,
): boolean {
  return range.start.y <= bufferLineNumber && bufferLineNumber <= range.end.y;
}

function cellAt(
  logical: LogicalLine,
  offset: number,
): { x: number; y: number } {
  for (const s of logical.segments) {
    if (offset < s.offset + s.len) {
      return { x: s.x + (offset - s.offset) + 1, y: s.y };
    }
  }
  const last = logical.segments[logical.segments.length - 1];
  return last ? { x: last.x + last.len, y: last.y } : { x: 1, y: 1 };
}

/** One row's cells as text: exactly one character per cell.
 *
 *  Both invariants keep an offset mapping back to a cell:
 *
 *  - **Not trimmed.** Trimming would shorten a row and slide every later
 *    offset. Trailing spaces cost nothing — no path or URL contains one.
 *  - **One char per cell.** A cell holding a grapheme that isn't a single code
 *    unit (an emoji surrogate pair, a combining sequence) becomes a space
 *    instead of contributing two characters to one cell. Nothing is lost:
 *    both regexes match ASCII, so such a character could never be part of a
 *    token. The empty second cell of a double-width character becomes a space
 *    too, which is what keeps its width honest. */
function rowText(line: IBufferLine): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const chars = line.getCell(i)?.getChars() ?? "";
    out += chars.length === 1 ? chars : " ";
  }
  return out;
}

function lastNonBlankIndex(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] !== " ") return i;
  return -1;
}

function indentOf(s: string): number {
  for (let i = 0; i < s.length; i++) if (s[i] !== " ") return i;
  return -1;
}

/** Dev-only trace of a stitched seam, capped so a hover storm can't flood the
 *  log. The heuristic above is inferred from how Claude's TUI renders, not
 *  from anything the buffer states outright, so being able to read back what
 *  it actually joined is worth the twenty lines it costs. */
let softJoinLogs = 0;
function logSoftJoin(prev: string, cur: string, y: number): void {
  if (!import.meta.env?.DEV || softJoinLogs >= 20) return;
  softJoinLogs++;
  const lastIdx = lastNonBlankIndex(prev);
  debugLog(
    "links.softjoin",
    `y=${y} cols=${prev.length} lastNonBlank=${lastIdx} indent=${indentOf(cur)} ` +
      `seam=${JSON.stringify(prev.slice(Math.max(0, lastIdx - 11), lastIdx + 1))}` +
      `+${JSON.stringify(cur.trimStart().slice(0, 12))}`,
  );
}
