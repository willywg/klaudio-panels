import { invoke } from "@tauri-apps/api/core";

/** Forwards a log line to Rust's stderr via the `debug_log` command. Stderr
 *  from `bun tauri dev` survives webview reloads, so anything we fire here
 *  is still inspectable even after a WebKit renderer crash wipes the
 *  console. Fire-and-forget — we never await, never throw. */
export function debugLog(tag: string, msg: string): void {
  void invoke("debug_log", { tag, msg }).catch(() => {
    // nothing to do — the log channel is best-effort
  });
}

/** Install window-level handlers that forward uncaught errors and rejected
 *  promises into the Rust stderr channel. Call once from App bootstrap. */
export function installGlobalErrorForwarding(): void {
  window.addEventListener("error", (e) => {
    const detail = e.error ? String(e.error.stack ?? e.error) : e.message;
    debugLog("window.error", `${e.filename}:${e.lineno}:${e.colno} — ${detail}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const detail =
      reason && typeof reason === "object" && "stack" in reason
        ? String((reason as { stack?: string }).stack)
        : String(reason);
    debugLog("window.rejection", detail);
  });
}
