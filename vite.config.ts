import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    // Scope Vite's file watcher to the frontend source. The embedded editor
    // lets users save arbitrary files inside the user's project (README.md,
    // docs, config) — without this scoping, every `:w` from nvim triggers
    // a full webview reload because Vite sees the change in CWD. HMR-for-src
    // still works: Vite's plugin system injects its own watchers for
    // imported modules regardless of `watch.ignored`.
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.git/**",
        "**/node_modules/**",
        "**/target/**",
        "**/dist/**",
        "**/*.md",
        "**/PROJECT.md",
        "**/PRPs/**",
        "**/docs/**",
      ],
    },
  },
}));
