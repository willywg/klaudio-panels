import { describe, expect, test } from "bun:test";
import { isImagePath } from "./image-files";

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
