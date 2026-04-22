import { openUrl } from "@tauri-apps/plugin-opener";

/** Shared click handler for xterm's WebLinksAddon. WebKit's default
 *  `window.open(uri, "_blank")` either no-ops or opens a second webview
 *  inside Tauri; users expect the OS default browser. The plugin hops
 *  through Rust and calls `NSWorkspace.openURL` / `xdg-open`. */
export function openUrlInSystemBrowser(
  _event: MouseEvent,
  uri: string,
): void {
  void openUrl(uri).catch((err) => console.warn("openUrl failed", uri, err));
}
