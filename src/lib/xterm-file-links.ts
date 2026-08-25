import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
  cellRange,
  rangeSpansRow,
  readLogicalLine,
} from "@/lib/xterm-logical-line";

/** Matches tokens that look like source paths, optionally trailed by a
 *  `:line[:col]` suffix. URLs are skipped (handled by WebLinksAddon).
 *
 *  Three branches, because how much evidence a token needs depends on how
 *  much it already announces about itself:
 *
 *  1. **Absolute**, two segments or more — `/etc/hosts`,
 *     `/Users/me/proj/.env`. No extension required: nothing in prose starts
 *     with `/Users/`. Two segments rather than one so Claude's own slash
 *     commands (`/compact`, `/model`) stay plain text (#91).
 *  2. **Home or explicitly relative** — `~/.zshrc`, `./foo.ts:42`,
 *     `../bin/run`. Also no extension: the prefix is unambiguous, so one
 *     segment is enough.
 *  3. **Bare relative** — `src/lib/bar.rs`, `CLAUDE.md:12`. Here the
 *     extension is *load-bearing*: drop it and `and/or`, `input/output` and
 *     `2026/08/20` all become links.
 *
 *  Requiring only branch 3's evidence everywhere is what made a dotfile or an
 *  extensionless file unclickable — `.env` has no second dot to spend on an
 *  extension, and `.kamal/secrets` has none at all (#91).
 *
 *  The extension must **start with a letter**. Claude prints `tok: 1193.8M`,
 *  `(195.9KB)` and `v1.10.1` constantly, and a digits-only "extension" turned
 *  each of them into a link to a file that was never there — the last one
 *  right beside a real image path. */
export const PATH_RE =
  /(?:^|[\s(["'`])((?:\/[\w.@-]+(?:\/[\w.@-]+)+|(?:~\/|\.{1,2}\/)[\w.@-]+(?:\/[\w.@-]+)*|[\w.@-]+(?:\/[\w.@-]+)*\.[a-zA-Z][\w]{0,9})(?::\d+(?::\d+)?)?)/g;

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

