const ENABLED_KEY = "clipboardHistoryEnabled";

/** Recording defaults to ON; the key is only written when the user turns it
 *  off, so an absent key means "never touched it". */
export function getClipboardEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setClipboardEnabled(v: boolean): void {
  try {
    if (v) localStorage.removeItem(ENABLED_KEY);
    else localStorage.setItem(ENABLED_KEY, "0");
  } catch {
    // ignore
  }
}

/** Collapse a clip to a single line for the dropdown row. Real newlines
 *  become "⏎" so a multi-line snippet still reads as one row instead of
 *  silently showing only its first line. */
export function previewOf(text: string, max = 140): string {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** "3 lines · 1.2 KB" — the detail line under each row. */
export function describeClip(text: string): string {
  const lines = text.split("\n").length;
  const bytes = new TextEncoder().encode(text).length;
  const size =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return lines > 1 ? `${lines} lines · ${size}` : size;
}
