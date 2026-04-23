import {
  Code2,
  FileCode,
  FileText,
  Folder,
  Hammer,
  Sparkles,
  Terminal,
  Wind,
  type LucideProps,
} from "lucide-solid";
import type { Component } from "solid-js";

type LucideIcon = Component<LucideProps>;

export type OpenInApp = {
  id: string;
  label: string;
  /** Name passed to `open -a` on macOS (bundle display name). */
  openWith: string;
  /** Hint only; used by the Sprint 06 PTY-embed planning. */
  kind: "gui" | "terminal" | "finder";
  /** Lucide icon component + tailwind text color for the avatar. */
  icon: LucideIcon;
  color: string;
  /** When set, this entry is a terminal editor embedded in a secondary PTY.
   *  The value is the TerminalEditor id. Callers must route clicks to
   *  `useEditorPty().openEditor(...)` instead of `open -a`. Detection uses
   *  `check_binary_exists` (PATH probe) instead of `check_app_exists`. */
  terminalEditor?: string;
};

/** macOS apps we try to detect. Terminal-only CLI editors (nvim, helix) are
 *  deliberately excluded — `open -a nvim` fails silently because they ship
 *  no .app bundle. They land in Sprint 06 via a secondary PTY preview pane.
 *
 *  The `icon` + `color` here are the Lucide fallback rendered while the real
 *  .app icon is being extracted (or if extraction fails). */
export const MAC_APPS: readonly OpenInApp[] = [
  { id: "vscode",          label: "VS Code",         openWith: "Visual Studio Code", kind: "gui",      icon: Code2,    color: "text-sky-400" },
  { id: "cursor",          label: "Cursor",          openWith: "Cursor",              kind: "gui",      icon: Code2,    color: "text-neutral-200" },
  { id: "windsurf",        label: "Windsurf",        openWith: "Windsurf",            kind: "gui",      icon: Wind,     color: "text-teal-400" },
  { id: "antigravity",     label: "Antigravity",     openWith: "Antigravity",         kind: "gui",      icon: Sparkles, color: "text-emerald-400" },
  { id: "zed",             label: "Zed",             openWith: "Zed",                 kind: "gui",      icon: Code2,    color: "text-orange-400" },
  { id: "xcode",           label: "Xcode",           openWith: "Xcode",               kind: "gui",      icon: Hammer,   color: "text-sky-500" },
  { id: "android-studio",  label: "Android Studio",  openWith: "Android Studio",      kind: "gui",      icon: Code2,    color: "text-emerald-400" },
  { id: "intellij",        label: "IntelliJ IDEA",   openWith: "IntelliJ IDEA",       kind: "gui",      icon: Code2,    color: "text-fuchsia-400" },
  { id: "webstorm",        label: "WebStorm",        openWith: "WebStorm",            kind: "gui",      icon: Code2,    color: "text-cyan-400" },
  { id: "pycharm",         label: "PyCharm",         openWith: "PyCharm",             kind: "gui",      icon: Code2,    color: "text-amber-300" },
  { id: "fleet",           label: "Fleet",           openWith: "Fleet",               kind: "gui",      icon: Code2,    color: "text-indigo-300" },
  { id: "rider",           label: "Rider",           openWith: "Rider",               kind: "gui",      icon: Code2,    color: "text-rose-400" },
  { id: "sublime",         label: "Sublime Text",    openWith: "Sublime Text",        kind: "gui",      icon: FileCode, color: "text-amber-400" },
  { id: "textmate",        label: "TextMate",        openWith: "TextMate",            kind: "gui",      icon: FileText, color: "text-neutral-300" },
  { id: "nova",            label: "Nova",            openWith: "Nova",                kind: "gui",      icon: FileCode, color: "text-indigo-400" },
  { id: "bbedit",          label: "BBEdit",          openWith: "BBEdit",              kind: "gui",      icon: FileText, color: "text-orange-300" },
  { id: "iterm2",          label: "iTerm",           openWith: "iTerm",               kind: "terminal", icon: Terminal, color: "text-emerald-400" },
  { id: "warp",            label: "Warp",            openWith: "Warp",                kind: "terminal", icon: Terminal, color: "text-violet-400" },
  { id: "ghostty",         label: "Ghostty",         openWith: "Ghostty",             kind: "terminal", icon: Terminal, color: "text-fuchsia-400" },
  { id: "terminal",        label: "Terminal",        openWith: "Terminal",            kind: "terminal", icon: Terminal, color: "text-neutral-400" },
] as const;

/** Terminal editors that Klaudio Panels embeds in a secondary PTY (Sprint 06). They
 *  ship no `.app` bundle, so `open -a nvim` fails silently — we detect them
 *  via `check_binary_exists` on the hydrated shell PATH. */
export const TERMINAL_EDITOR_APPS: readonly OpenInApp[] = [
  { id: "nvim",  label: "Neovim", openWith: "nvim",  kind: "terminal", icon: Terminal, color: "text-emerald-300", terminalEditor: "nvim" },
  { id: "vim",   label: "Vim",    openWith: "vim",   kind: "terminal", icon: Terminal, color: "text-green-400",    terminalEditor: "vim" },
  { id: "helix", label: "Helix",  openWith: "hx",    kind: "terminal", icon: Terminal, color: "text-indigo-300",   terminalEditor: "helix" },
  { id: "micro", label: "Micro",  openWith: "micro", kind: "terminal", icon: Terminal, color: "text-amber-300",    terminalEditor: "micro" },
] as const;

export const FINDER_APP: OpenInApp = {
  id: "finder",
  label: "Finder",
  openWith: "Finder",
  kind: "finder",
  icon: Folder,
  color: "text-cyan-400",
};

const STORAGE_KEY = "openIn.app";
const EDITOR_STORAGE_KEY = "openIn.terminalEditor";

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

export function getDefaultTerminalEditorId(): string | null {
  try {
    return localStorage.getItem(EDITOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setDefaultTerminalEditorId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(EDITOR_STORAGE_KEY);
    else localStorage.setItem(EDITOR_STORAGE_KEY, id);
  } catch {
    // ignore
  }
}
