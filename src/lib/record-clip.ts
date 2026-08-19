import { invoke } from "@tauri-apps/api/core";

/** Report a copy made inside Klaudio to the clipboard history.
 *
 *  The history only ever holds what Klaudio itself copied: `pbcopy` run in
 *  one of our PTYs (caught by the shim on the child's PATH) and ⌘C in one of
 *  our terminals, which is this. Nothing observes the system pasteboard, so
 *  a copy made in another app never reaches the panel.
 *
 *  Best-effort by design — a failure here must never interfere with the copy
 *  the user actually asked for. */
export function recordClip(text: string): void {
  if (!text.trim()) return;
  void invoke("clipboard_record", { text }).catch((err) =>
    console.warn("clipboard_record failed", err),
  );
}
