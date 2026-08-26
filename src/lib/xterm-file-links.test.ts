import { describe, expect, test } from "bun:test";
import type { ILink, Terminal } from "@xterm/xterm";
import { makeFileLinkProvider, PATH_RE } from "./xterm-file-links";

/** Pull every path token the provider would linkify out of a line. */
function matches(line: string): string[] {
  PATH_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(line)) !== null) out.push(m[1]);
  return out;
}

describe("PATH_RE", () => {
  test("matches the shape Claude prints image references in", () => {
    // The motivating case for #73: before the `~/` branch existed, the
    // leading tilde fell outside the character class and this line produced
    // no match at all.
    expect(
      matches("  > [image] ~/proyectos/construct-ai/qa2278-01.jpeg (195.9KB)"),
    ).toContain("~/proyectos/construct-ai/qa2278-01.jpeg");
  });

  test("matches absolute paths", () => {
    expect(matches("wrote /tmp/out/shot.png ok")).toContain(
      "/tmp/out/shot.png",
    );
  });

  test("still matches the pre-existing shapes", () => {
    expect(matches("see src/lib/bar.rs for details")).toContain(
      "src/lib/bar.rs",
    );
    expect(matches("at ./foo.ts:42")).toContain("./foo.ts:42");
    expect(matches("CLAUDE.md:12 says")).toContain("CLAUDE.md:12");
  });

  test("a bare tilde is not a path", () => {
    expect(matches("cd ~ then run")).toEqual([]);
  });

  // #91: the extension was required on every branch, so a path whose last
  // segment had none was invisible — while a sibling in the same printed
  // list linkified, which is what made it look random rather than absent.
  test("an absolute path needs no file extension", () => {
    expect(matches("  /Users/me/proj/.env")).toEqual(["/Users/me/proj/.env"]);
    expect(matches("  /Users/me/proj/.kamal/secrets")).toEqual([
      "/Users/me/proj/.kamal/secrets",
    ]);
    expect(matches("edit /etc/hosts now")).toContain("/etc/hosts");
  });

  test("a home or explicitly relative path needs no extension either", () => {
    expect(matches("open ~/.zshrc please")).toContain("~/.zshrc");
    expect(matches("run ../bin/run first")).toContain("../bin/run");
  });

  test("a slash command is not an absolute path", () => {
    // Claude's own TUI prints these, and its status line ends in `/rc`. One
    // segment is the line between them and a real path — no file worth
    // opening lives at the root.
    expect(matches("usa /compact para limpiar")).toEqual([]);
    expect(matches("/model opus")).toEqual([]);
  });

  test("a bare relative token still needs evidence beyond a slash", () => {
    // Load-bearing: these forms have no prefix vouching for them, so a slash
    // alone can never be enough — this is ordinary prose.
    expect(matches("and/or, input/output")).toEqual([]);
    expect(matches("el 2026/08/20 salio")).toEqual([]);
  });

  // #95: the extension was the *only* evidence a bare relative path could
  // offer, so half of what Claude prints in a project inventory — every
  // dotfile, every directory — was dead text sitting beside links that worked.
  test("a dot-leading segment stands in for an extension", () => {
    expect(matches("mira web/.env ahi")).toContain("web/.env");
    expect(matches("no hay .env en la raiz")).toContain(".env");
    expect(matches("y .kamal/secrets tambien")).toContain(".kamal/secrets");
    // The dot may sit in any segment, not just the last one.
    expect(matches("core/.github/workflows/test.yml corre")).toContain(
      "core/.github/workflows/test.yml",
    );
  });

  test("a trailing slash stands in for an extension", () => {
    expect(matches("ver docs/assets/brand/ ahi")).toContain(
      "docs/assets/brand/",
    );
    // One segment is enough when the slash is trailing: `web/` is a directory,
    // and unlike `and/or` there is nothing after the slash to be a second word.
    expect(matches("- web/ no tiene workflow de CI.")).toContain("web/");
  });

  test("a sed expression is a known, accepted false positive", () => {
    // `s/foo/bar/` is the same shape as `docs/assets/brand/` and nothing in
    // the text separates them. Pinned rather than fixed: ruling it out means
    // ruling out one-segment directories, which Claude prints far more often.
    // It resolves to nothing and the preview says so.
    expect(matches("ejecuta s/foo/bar/ ahi")).toEqual(["s/foo/bar/"]);
  });

  test("an ellipsis run into a word is not a file with an extension", () => {
    // `..` was a legal segment, so this read as the file `..` with the
    // extension `.continua`.
    expect(matches("algo ...continua aca")).toEqual([]);
  });

  test("a number is not a filename with an extension", () => {
    // All three are printed constantly by Claude and by our own status line;
    // `195.9KB` sits directly beside a real image path.
    expect(matches("tok: 1193.8M (out: 6.8M)")).toEqual([]);
    expect(matches("klaudio v1.10.1 salio")).toEqual([]);
    expect(matches("  > [image] ~/proj/qa.jpeg (195.9KB)")).toEqual([
      "~/proj/qa.jpeg",
    ]);
  });

  test("a URL is left to the web-links addon", () => {
    expect(matches("ver https://example.com/a/b ahi")).toEqual([]);
  });
});

/** A terminal whose single logical line is `s`, wrapped at `cols` — what
 *  xterm does to a path too long for the window. */
function wrappedTerm(s: string, cols: number): Terminal {
  const rows: { text: string; wrapped: boolean }[] = [];
  for (let i = 0; i < s.length; i += cols) {
    rows.push({ text: s.slice(i, i + cols), wrapped: i > 0 });
  }
  const lines = rows.map((r) => ({
    length: cols,
    isWrapped: r.wrapped,
    getCell: (i: number) => ({ getChars: () => r.text[i] ?? "" }),
  }));
  return {
    buffer: { active: { getLine: (y: number) => lines[y] } },
  } as unknown as Terminal;
}

function linksOnRow(term: Terminal, row: number): ILink[] {
  const provider = makeFileLinkProvider(term, () => {});
  let got: ILink[] = [];
  provider.provideLinks(row, (links) => {
    got = links ?? [];
  });
  return got;
}

describe("wrapped lines", () => {
  // The bug (#87): reading one row at a time saw
  // `/private/tmp/claude-501/-Users-willywg-proyectos-pet-projects-ch` and a
  // dangling `asqui/…`. The first opened nothing; the second was matched as a
  // bare relative name and hunted for inside the project.
  const path =
    "/private/tmp/claude-501/-Users-willywg-proyectos-pet-projects-chasqui/44fd0760/scratchpad/test-note.md";
  const COLS = 60;

  test("a path split across rows is one link carrying the whole path", () => {
    const links = linksOnRow(wrappedTerm(path, COLS), 1);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe(path);
  });

  test("its range spans the rows it wrapped onto", () => {
    const [link] = linksOnRow(wrappedTerm(path, COLS), 1);
    expect(link.range.start).toEqual({ x: 1, y: 1 });
    expect(link.range.end.y).toBe(Math.ceil(path.length / COLS));
  });

  test("the same link is reported from a continuation row", () => {
    // Hovering the tail has to work too, not just the head — and the link
    // must be reported once per row rather than once per match.
    const links = linksOnRow(wrappedTerm(path, COLS), 2);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe(path);
  });

  test("a path that fits stays on its own row", () => {
    const links = linksOnRow(wrappedTerm("/tmp/a.md", COLS), 1);
    expect(links).toHaveLength(1);
    expect(links[0].range.end.y).toBe(1);
  });
});
