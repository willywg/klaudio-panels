import { describe, expect, test } from "bun:test";
import {
  isImagePath,
  relativizeToProject,
  resolveImagePath,
} from "./image-files";

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
  // The async branch (bare filename -> Rust search) needs the Tauri bridge,
  // so only the two synchronous shapes are exercised here.
  test("absolute and home paths pass straight through", async () => {
    expect(await resolveImagePath("/proj", "/tmp/a.png")).toBe("/tmp/a.png");
    expect(await resolveImagePath("/proj", "~/shots/a.png")).toBe(
      "~/shots/a.png",
    );
  });

  test("a path with a directory is joined onto the project", async () => {
    expect(await resolveImagePath("/proj", "public/images/logo.png")).toBe(
      "/proj/public/images/logo.png",
    );
    expect(await resolveImagePath("/proj/", "./a/b.png")).toBe("/proj/a/b.png");
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
