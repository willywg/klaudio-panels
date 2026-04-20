export type OpenInApp = {
  id: string;
  label: string;
  /** Name passed to `open -a` on macOS (bundle display name). */
  openWith: string;
  /** Whether this app is a terminal (for Sprint 06 preview-pane planning). */
  kind: "gui" | "terminal" | "finder";
  /** Tailwind bg + hex fallback for a simple circle avatar when we don't
   *  have a real icon asset. */
  color: string;
};

/** macOS apps we try to detect. Order defines dropdown order. Finder is
 *  pinned separately (always present). */
export const MAC_APPS: readonly OpenInApp[] = [
  { id: "vscode", label: "VS Code", openWith: "Visual Studio Code", kind: "gui", color: "bg-blue-500" },
  { id: "cursor", label: "Cursor", openWith: "Cursor", kind: "gui", color: "bg-neutral-300" },
  { id: "zed", label: "Zed", openWith: "Zed", kind: "gui", color: "bg-orange-500" },
  { id: "xcode", label: "Xcode", openWith: "Xcode", kind: "gui", color: "bg-sky-500" },
  { id: "sublime", label: "Sublime Text", openWith: "Sublime Text", kind: "gui", color: "bg-amber-400" },
  { id: "iterm2", label: "iTerm", openWith: "iTerm", kind: "terminal", color: "bg-emerald-500" },
  { id: "warp", label: "Warp", openWith: "Warp", kind: "terminal", color: "bg-violet-500" },
  { id: "ghostty", label: "Ghostty", openWith: "Ghostty", kind: "terminal", color: "bg-fuchsia-500" },
  { id: "terminal", label: "Terminal", openWith: "Terminal", kind: "terminal", color: "bg-neutral-500" },
] as const;

export const FINDER_APP: OpenInApp = {
  id: "finder",
  label: "Finder",
  openWith: "Finder",
  kind: "finder",
  color: "bg-cyan-500",
};

const STORAGE_KEY = "openIn.app";

export function getLastOpenInApp(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? FINDER_APP.id;
  } catch {
    return FINDER_APP.id;
  }
}

export function setLastOpenInApp(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
}
