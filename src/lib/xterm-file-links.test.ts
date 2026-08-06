import { describe, expect, test } from "bun:test";
import { PATH_RE } from "./xterm-file-links";

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
});
