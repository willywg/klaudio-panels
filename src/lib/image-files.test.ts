import { describe, expect, mock, test } from "bun:test";
import { answerFilePick, pendingFilePick } from "@/lib/file-picker-bus";

/** What the (mocked) backend will answer for the next lookup. Each test uses
 *  a distinct project path so `projectFileCandidates`' cache never serves a
 *  previous test's answer. */
let candidates: string[] = [];
function setCandidates(next: string[]) {
  candidates = next;
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: async () => candidates,
}));

const { isImagePath, relativizeToProject, resolveImagePath } = await import(
  "./image-files"
);

/** Let the resolver run up to the point where it opens the picker. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("isImagePath", () => {
  test("accepts the allowlisted extensions, case-insensitively", () => {
    expect(isImagePath("shot.png")).toBe(true);
    expect(isImagePath("~/proyectos/qa/before.jpeg")).toBe(true);
    expect(isImagePath("/tmp/A.JPG")).toBe(true);
    expect(isImagePath("src/assets/logo.svg")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isImagePath("src/main.ts")).toBe(false);
    expect(isImagePath("README.md")).toBe(false);
    expect(isImagePath("Makefile")).toBe(false);
    // A dotfile's leading dot doesn't make its name an extension.
    expect(isImagePath(".gitignore")).toBe(false);
    expect(isImagePath("archive.png.gz")).toBe(false);
  });

  test("only the basename's extension counts", () => {
    // A directory that looks like an image must not make a file look like one.
    expect(isImagePath("assets.png/notes.txt")).toBe(false);
    expect(isImagePath("assets.txt/shot.png")).toBe(true);
  });
});

describe("resolveImagePath shapes", () => {
  test("absolute and home paths pass straight through", async () => {
    // No resolver involved: `read_image` reads from anywhere on disk, which
    // is how screenshots outside the project work at all (#73).
    expect(await resolveImagePath("/proj", "/tmp/a.png")).toBe("/tmp/a.png");
    expect(await resolveImagePath("/proj", "~/shots/a.png")).toBe(
      "~/shots/a.png",
    );
  });

  test("a traversal path is joined rather than searched", async () => {
    // It leaves the project, so the suffix search has nothing to say about
    // it; the join still opens it when it exists.
    expect(await resolveImagePath("/proj", "../sibling/a.png")).toBe(
      "/proj/../sibling/a.png",
    );
  });
});

describe("resolveImagePath against the project", () => {
  test("uses the resolved candidate, not a blind join", async () => {
    // The bug: `public/logo.png` printed by a session running in `web/` was
    // joined onto the root, and `<root>/public/logo.png` doesn't exist.
    setCandidates(["web/public/logo.png"]);
    expect(await resolveImagePath("/p1", "public/logo.png")).toBe(
      "/p1/web/public/logo.png",
    );
  });

  test("a bare filename still resolves", async () => {
    setCandidates(["app/assets/logo.png"]);
    expect(await resolveImagePath("/p2", "./logo.png")).toBe(
      "/p2/app/assets/logo.png",
    );
  });

  test("nothing matching stays quiet", async () => {
    setCandidates([]);
    expect(await resolveImagePath("/p3", "gone.png")).toBeNull();
  });

  test("a hover takes the best candidate instead of asking", async () => {
    // Asking on hover would pop a modal at the mouse pointer for a thumbnail
    // nobody committed to opening.
    setCandidates(["a/x.png", "b/x.png"]);
    expect(await resolveImagePath("/p4", "x.png")).toBe("/p4/a/x.png");
    expect(pendingFilePick()).toBeNull();
  });

  test("a click asks which one, and honours the answer", async () => {
    setCandidates(["core/x.png", "web/x.png"]);
    const p = resolveImagePath("/p5", "x.png", { ask: true });
    await flush();
    expect(pendingFilePick()?.candidates).toEqual(["core/x.png", "web/x.png"]);
    answerFilePick("web/x.png");
    expect(await p).toBe("/p5/web/x.png");
  });

  test("a dismissed picker resolves to null", async () => {
    setCandidates(["core/y.png", "web/y.png"]);
    const p = resolveImagePath("/p6", "y.png", { ask: true });
    await flush();
    answerFilePick(null);
    expect(await p).toBeNull();
  });
});

describe("relativizeToProject", () => {
  test("strips the project prefix when the file is inside it", () => {
    expect(relativizeToProject("/proj", "/proj/public/logo.png")).toBe(
      "public/logo.png",
    );
  });

  test("leaves outside-the-project paths absolute", () => {
    expect(relativizeToProject("/proj", "/other/logo.png")).toBe(
      "/other/logo.png",
    );
    // A sibling directory sharing the prefix is not inside the project.
    expect(relativizeToProject("/proj", "/project2/logo.png")).toBe(
      "/project2/logo.png",
    );
  });
});
