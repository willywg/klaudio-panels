import { expect, test } from "bun:test";
import pkg from "../../package.json";

test("Windows GNU packaging explicitly selects the ABI that bundles its loader DLL", () => {
  expect(pkg.scripts).toHaveProperty(
    "release:windows-gnu",
    "tauri build --target x86_64-pc-windows-gnu --bundles nsis",
  );
});

test("the existing frontend and macOS build commands remain unchanged", () => {
  expect(pkg.scripts.build).toBe("vite build");
  expect(pkg.scripts.tauri).toBe("tauri");
  expect(pkg.scripts["release:mac"]).toBe("tauri build --target universal-apple-darwin");
});
