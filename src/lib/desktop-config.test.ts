import { expect, test } from "bun:test";
import config from "../../src-tauri/tauri.conf.json";

test("Tauri development uses the configured Vite server", () => {
  expect(config.build).toHaveProperty("devUrl", "http://localhost:1420");
});

test("shared window configuration preserves macOS native decorations", () => {
  expect(config.app.windows[0]).not.toHaveProperty("decorations", false);
});
