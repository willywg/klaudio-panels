import { invoke } from "@tauri-apps/api/core";
import {
  ERROR_SUMMARY_INTERVAL_MS,
  createDebugGate,
  type ForwardedError,
} from "@/lib/debug-log-gate";

const gate = createDebugGate({
  now: () => Date.now(),
  emit: (tag, msg) => {
    // Fire-and-forget. Never awaited, and a rejected IPC is swallowed so a
    // logging failure cannot itself become an unhandled rejection.
    void invoke("debug_log", { tag, msg }).catch(() => {});
  },
});

/** Forwards a log line to Rust's stderr via the `debug_log` command. Stderr
 *  from `bun tauri dev` survives webview reloads, so anything we fire here
 *  is still inspectable even after a WebKit renderer crash wipes the
 *  console. Best-effort: this never throws and never returns a promise. */
export function debugLog(tag: string, msg: string): void {
  try {
    gate.record(tag, msg);
  } catch {
    // nothing to do — the log channel is best-effort
  }
}

function forwarded(
  tag: string,
  name: string,
  message: string,
  stack: string | undefined,
  filename?: string,
  lineno?: number,
  colno?: number,
): ForwardedError {
  return { tag, name, message, stack, filename, lineno, colno };
}

/** Install window-level handlers that forward uncaught errors and rejected
 *  promises into the Rust stderr channel. Call once from App bootstrap.
 *  Identical errors are logged once, then summarized; see `debug-log-gate`. */
export function installGlobalErrorForwarding(): void {
  window.addEventListener("error", (e) => {
    // WebKit's `e.error.stack` is bare frames — no leading
    // `TypeError: message` line. Capture name + message separately so the
    // log tells us WHAT threw, not just WHERE.
    const err = e.error as { name?: string; message?: string; stack?: string } | undefined;
    const name = err?.name ?? err?.constructor?.name ?? "Error";
    const message = err?.message ?? e.message ?? "(no message)";
    try {
      gate.recordError(
        forwarded(
          "window.error",
          name,
          message,
          err?.stack,
          e.filename,
          e.lineno,
          e.colno,
        ),
      );
    } catch {
      // best-effort
    }
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason as
      | { name?: string; message?: string; stack?: string }
      | undefined;
    const name = reason?.name ?? reason?.constructor?.name ?? "Rejection";
    const message = reason?.message ?? String(e.reason);
    try {
      gate.recordError(forwarded("window.rejection", name, message, reason?.stack));
    } catch {
      // best-effort
    }
  });
  // A burst that keeps going past the interval gets its summary even if no
  // further distinct event arrives to trip the check inside `recordError`.
  window.setInterval(() => {
    try {
      gate.flush();
    } catch {
      // best-effort
    }
  }, ERROR_SUMMARY_INTERVAL_MS);
}
