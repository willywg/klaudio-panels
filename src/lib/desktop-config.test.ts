import { expect, test } from "bun:test";
import config from "../../src-tauri/tauri.conf.json";

test("Tauri development uses the configured Vite server and bun scripts", () => {
  expect(config.build).toHaveProperty("devUrl", "http://localhost:1420");
  expect(config.build).toHaveProperty("beforeDevCommand", "bun run dev");
  expect(config.build).toHaveProperty("beforeBuildCommand", "bun run build");
});

test("shared window configuration preserves macOS native decorations", () => {
  expect(config.app.windows[0]).not.toHaveProperty("decorations", false);
});
