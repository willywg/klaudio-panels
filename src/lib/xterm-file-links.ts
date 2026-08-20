import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
  cellRange,
  rangeSpansRow,
  readLogicalLine,
} from "@/lib/xterm-logical-line";

/** Matches tokens that look like source paths, optionally trailed by a
 *  `:line[:col]` suffix. Accepts `./foo.ts`, `src/lib/bar.rs`, `foo.ts:42`,
 *  bare filenames with extension like `CLAUDE.md:12`, and — since #73 —
 *  home-relative and absolute paths (`~/shots/a.png`, `/tmp/a.png`). Claude
 *  prints image references as `[image] ~/…`, and without the `~/` branch
 *  the leading `~` fell outside the character class, so those tokens matched
 *  nothing at all. URLs are skipped (handled by WebLinksAddon). */
export const PATH_RE =
  /(?:^|[\s(["'`])((?:~\/|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[\w]{1,10}(?::\d+(?::\d+)?)?)/g;

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

