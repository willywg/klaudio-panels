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
    // WebKit's `e.error.stack` is bare frames — no leading
    // `TypeError: message` line. Capture name + message separately so the
    // log tells us WHAT threw, not just WHERE.
    const err = e.error as { name?: string; message?: string; stack?: string } | undefined;
    const name = err?.name ?? err?.constructor?.name ?? "Error";
    const message = err?.message ?? e.message ?? "(no message)";
    const stack = err?.stack ?? "(no stack)";
    debugLog(
      "window.error",
      `${e.filename}:${e.lineno}:${e.colno} — ${name}: ${message}\n${stack}`,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason as
      | { name?: string; message?: string; stack?: string }
      | undefined;
    const name = reason?.name ?? reason?.constructor?.name ?? "Rejection";
    const message = reason?.message ?? String(e.reason);
    const stack = reason?.stack ?? "(no stack)";
    debugLog("window.rejection", `${name}: ${message}\n${stack}`);
  });
}
