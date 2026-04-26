/** Tiny window-event-bus toast. The Toaster component listens; anyone can
 *  fire a notification with `toast(...)` — no provider/context required. */

export type ToastKind = "info" | "error";

export type ToastDetail = {
  id: number;
  kind: ToastKind;
  message: string;
  durationMs: number;
};

export const TOAST_EVENT = "klaudio:toast";

let nextId = 1;

export function toast(message: string, kind: ToastKind = "info", durationMs = 4000) {
  const detail: ToastDetail = { id: nextId++, kind, message, durationMs };
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail }));
}
