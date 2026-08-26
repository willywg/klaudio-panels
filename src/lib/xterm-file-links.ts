import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
  cellRange,
  rangeSpansRow,
  readLogicalLine,
} from "@/lib/xterm-logical-line";

/** One path segment: word characters plus the punctuation real filenames
 *  carry. */
const SEG = String.raw`[\w.@-]+`;

/** A segment that does not *end* in a dot, for use immediately before an
 *  extension. Without it `..` is a legal segment and `...continua` reads as
 *  the file `..` with extension `.continua`. */
const NAME = String.raw`[\w.@-]*[\w@-]`;

/** A file extension. It must **start with a letter**: Claude prints
 *  `tok: 1193.8M`, `(195.9KB)` and `v1.10.1` constantly, and a digits-only
 *  "extension" turned each of them into a link to a file that was never
 *  there — the last one right beside a real image path. */
const EXT = String.raw`\.[a-zA-Z][\w]{0,9}`;

/** The forms a path token may take, in the order they are tried.
 *
 *  How much evidence a token needs depends on how much it already announces
 *  about itself. The first two say where they live, so a slash is enough. The
 *  last three are bare relative paths, indistinguishable in shape from
 *  ordinary prose — `and/or`, `input/output`, `2026/08/20` — so each needs
 *  one more thing that prose does not have. */
const FORMS = [
  // 1. Absolute, two segments or more. `/Users/me/proj/.env`. No extension
  //    required: nothing in prose starts with `/Users/`. Two segments rather
  //    than one keeps Claude's own slash commands (`/compact`, `/model`)
  //    plain text (#91).
  String.raw`\/${SEG}(?:\/${SEG})+`,
  // 2. Home or explicitly relative — `~/.zshrc`, `./foo.ts:42`, `../bin/run`.
  //    The prefix is unambiguous, so one segment is enough.
  String.raw`(?:~\/|\.{1,2}\/)${SEG}(?:\/${SEG})*`,
  // 3. Bare relative carrying an extension — `src/lib/bar.rs`, `CLAUDE.md:12`.
  String.raw`${NAME}(?:\/${SEG})*${EXT}`,
  // 4. Bare relative with a dot-leading segment — `.env`, `web/.env`,
  //    `.kamal/secrets`. A dotfile has no second dot to spend on an
  //    extension, and prose does not begin a word with a dot, so the dot is
  //    the evidence. The segment may sit anywhere: `.kamal/secrets` carries
  //    it first and `web/.env` last (#95).
  String.raw`(?:${SEG}\/)*\.[a-zA-Z][\w.@-]*(?:\/${SEG})*`,
  // 5. Bare relative ending in a slash — `docs/assets/brand/`, `web/`. A
  //    directory has no extension to offer, but a *trailing* slash is
  //    evidence prose lacks: `and/or` has a slash between words, never after
  //    the last one. The lookahead is what makes that distinction — without
  //    it `and/or` matches as `and/` (#95).
  //
  //    Known cost: a sed expression, `s/foo/bar/`, is this exact shape and
  //    does linkify. It resolves to nothing and the preview says so. Ruling
  //    it out would mean ruling out one-segment directories like `web/`,
  //    which Claude prints far more often than sed one-liners.
  String.raw`${SEG}(?:\/${SEG})*\/(?![\w.@-])`,
].join("|");

/** Matches tokens that look like paths, optionally trailed by a `:line[:col]`
 *  suffix. URLs are skipped (handled by WebLinksAddon).
 *
 *  Assembled from `FORMS` rather than written out: as one literal this is a
 *  120-character line whose five alternatives cannot be commented
 *  individually, and the reasoning for each is the part worth keeping. */
export const PATH_RE = new RegExp(
  String.raw`(?:^|[\s(["'\`])((?:${FORMS})(?::\d+(?::\d+)?)?)`,
  "g",
);

export type XtermFileClick = { rel: string; line?: number };

export type XtermLinkHooks = {
  /** Called on mouse-enter of a link, with the matched path. Return value is
   *  ignored; implementations position their own overlay. */
  onHover?: (path: string, event: MouseEvent) => void;
  onLeave?: (path: string) => void;
};

export function makeFileLinkProvider(
  term: Terminal,
  onActivate: (info: XtermFileClick, event: MouseEvent) => void,
  hooks: XtermLinkHooks = {},
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      // The whole logical line, not just this row: an absolute path is long
      // enough that it usually wraps, and reading one row sees a truncated
      // fragment that opens nothing (#87).
      const logical = readLogicalLine(term, bufferLineNumber);
      if (!logical) return callback(undefined);
      const text = logical.text;
      if (!text.trim()) return callback(undefined);

      const links: ILink[] = [];
      PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(text)) !== null) {
        const full = m[1];
        const matchStart = m.index + m[0].length - full.length;
        const range = cellRange(logical, matchStart, full.length);
        // Every row of the group produces the same match list; keep only the
        // ones touching the row being asked about, or the same link would be
        // registered once per row.
        if (!rangeSpansRow(range, bufferLineNumber)) continue;
        // Split file:line[:col]
        const colonIdx = full.indexOf(":");
        let path = full;
        let lineNum: number | undefined;
        if (colonIdx !== -1 && /^\d+(?::\d+)?$/.test(full.slice(colonIdx + 1))) {
          path = full.slice(0, colonIdx);
          const lineStr = full.slice(colonIdx + 1).split(":")[0];
          lineNum = Number.parseInt(lineStr, 10) || undefined;
        }
        links.push({
          range,
          text: full,
          activate(event) {
            // Require a modifier; a bare click shouldn't hijack selection.
            if (!event.metaKey && !event.ctrlKey) return;
            onActivate({ rel: path, line: lineNum }, event);
          },
          hover(event) {
            hooks.onHover?.(path, event);
          },
          leave() {
            hooks.onLeave?.(path);
          },
        });
      }

      callback(links.length ? links : undefined);
    },
  };
}

