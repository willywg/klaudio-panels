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

  test("a bare relative token still needs an extension", () => {
    // Load-bearing: this is the only branch with no prefix vouching for it.
    expect(matches("and/or, input/output")).toEqual([]);
    expect(matches("el 2026/08/20 salio")).toEqual([]);
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
