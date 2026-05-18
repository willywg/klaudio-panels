import type { ILink, ILinkProvider, IBufferLine, Terminal } from "@xterm/xterm";
import { openUrlInSystemBrowser } from "@/lib/open-url";

/** TLDs we treat as "this is a URL, not a file path". Kept conservative on
 *  purpose — every entry here means a file ending in `.<tld>` will be
 *  hijacked into the browser. The file-link provider's greedy `[\w.@-]+`
 *  also matches `app.constructai.la` as if it were a file (`constructai.la`
 *  is its "extension"), so registering this provider BEFORE the file
 *  provider has the side effect of fixing that false positive — bare
 *  domains now route to the browser instead of opening a non-existent
 *  preview tab. */
const TLDS = [
  // Generic
  "com", "org", "net", "edu", "gov", "mil", "int", "info",
  "io", "dev", "app", "ai", "co", "me", "sh", "xyz",
  "tech", "cloud", "site", "online", "store", "page",
  // Country codes — Latin America first, then the common ones the user
  // tends to see in tooling output (GitHub orgs, docs sites, etc).
  "la", "ar", "br", "mx", "cl", "pe", "co", "ve", "uy", "py",
  "us", "uk", "ca", "au", "nz", "de", "fr", "es", "it", "nl",
  "se", "no", "fi", "pl", "ru", "jp", "cn", "in", "kr",
];

const HOST_PART = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// URL path chars per RFC 3986 reserved+unreserved set, conservative —
// trailing punctuation that's likely a sentence terminator (`.`, `,`, `;`,
// `!`, `?`, closing brackets) gets stripped post-match instead of being
// excluded by the regex, so we don't have to encode lookahead gymnastics.
const PATH_CHARS = "[\\w./?#=&%~+@!*',():;-]";
const URL_RE = new RegExp(
  // Prefix anchor: line start or a delimiter that wouldn't appear inside a
  // domain/path. Critically excludes `/` and `:` — that's what prevents
  // matching `linear.app` inside an already-https URL handled by
  // WebLinksAddon.
  `(?:^|[\\s(\\["'\`])((?:${HOST_PART}\\.)+(?:${TLDS.join("|")})(?::\\d{2,5})?(?:/${PATH_CHARS}*)?)`,
  "gi",
);

const TRAILING_PUNCT = /[.,;:!?)\]'"`]+$/;

export function makeBareUrlLinkProvider(term: Terminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) return callback(undefined);
      const text = stringifyLine(line);
      if (!text.trim()) return callback(undefined);

      const links: ILink[] = [];
      URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(text)) !== null) {
        const raw = m[1];
        const trimmed = raw.replace(TRAILING_PUNCT, "");
        if (!trimmed) continue;
        const matchStart = m.index + m[0].length - raw.length;
        const uri = `https://${trimmed}`;
        links.push({
          range: {
            start: { x: matchStart + 1, y: bufferLineNumber },
            end: { x: matchStart + trimmed.length, y: bufferLineNumber },
          },
          text: trimmed,
          activate(event) {
            openUrlInSystemBrowser(event, uri);
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
