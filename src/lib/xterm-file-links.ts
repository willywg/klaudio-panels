import type { ILink, ILinkProvider, IBufferLine, Terminal } from "@xterm/xterm";

/** Matches tokens that look like source paths, optionally trailed by a
 *  `:line[:col]` suffix. Accepts `./foo.ts`, `src/lib/bar.rs`, `foo.ts:42`,
 *  and bare filenames with extension like `CLAUDE.md:12`. URLs are skipped
 *  (those are handled by WebLinksAddon). */
const PATH_RE =
  /(?:^|[\s(["'`])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[\w]{1,10}(?::\d+(?::\d+)?)?)/g;

export type XtermFileClick = { rel: string; line?: number };

export function makeFileLinkProvider(
  term: Terminal,
  onActivate: (info: XtermFileClick, event: MouseEvent) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) return callback(undefined);
      const text = stringifyLine(line);
      if (!text.trim()) return callback(undefined);

      const links: ILink[] = [];
      PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(text)) !== null) {
        const full = m[1];
        const matchStart = m.index + m[0].length - full.length;
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
          range: {
            start: { x: matchStart + 1, y: bufferLineNumber },
            end: { x: matchStart + full.length, y: bufferLineNumber },
          },
          text: full,
          activate(event) {
            // Require a modifier; a bare click shouldn't hijack selection.
            if (!event.metaKey && !event.ctrlKey) return;
            onActivate({ rel: path, line: lineNum }, event);
          },
        });
      }

      callback(links.length ? links : undefined);
    },
  };
}

function stringifyLine(line: IBufferLine): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const cell = line.getCell(i);
    if (!cell) continue;
    const chars = cell.getChars();
    if (chars) out += chars;
    else out += " ";
  }
  return out.replace(/\s+$/, "");
}
