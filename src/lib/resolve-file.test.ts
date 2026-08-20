import { describe, expect, test } from "bun:test";
import {
  isAbsoluteish,
  needleOf,
  projectBase,
  resolveProjectFile,
} from "@/lib/resolve-file";

describe("path shapes", () => {
  test("absolute and home paths are recognised", () => {
    expect(isAbsoluteish("/private/tmp/x.md")).toBe(true);
    expect(isAbsoluteish("~/notes/x.md")).toBe(true);
    expect(isAbsoluteish("src/x.ts")).toBe(false);
    expect(isAbsoluteish("./src/x.ts")).toBe(false);
    // A bare `~` is a directory, not a file we'd ever be handed.
    expect(isAbsoluteish("~notuser/x.md")).toBe(false);
  });

  test("the needle drops only a leading ./", () => {
    expect(needleOf("./a/b.ts")).toBe("a/b.ts");
    expect(needleOf("a/b.ts")).toBe("a/b.ts");
    expect(needleOf("../a/b.ts")).toBe("../a/b.ts");
  });

  test("the base loses a trailing slash", () => {
    expect(projectBase("/proj/")).toBe("/proj");
    expect(projectBase("/proj")).toBe("/proj");
  });
});

describe("resolveProjectFile", () => {
  test("an absolute path is returned untouched, without asking the backend", async () => {
    // It already says where it lives. Searching the project for a suffix
    // match would answer a question nobody asked, and the preview reads it
    // directly (#85). No IPC happens here, which is why this needs no mock.
    const abs =
      "/private/tmp/claude-501/-Users-willywg-proyectos-construct-ai/x/scratchpad/notes.md";
    expect(await resolveProjectFile("/proj", abs)).toBe(abs);
    expect(await resolveProjectFile("/proj", "~/notes.md")).toBe("~/notes.md");
  });
});
