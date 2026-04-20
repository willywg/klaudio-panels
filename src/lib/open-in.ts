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
};

/** macOS apps we try to detect. Terminal-only CLI editors (nvim, helix) are
 *  deliberately excluded — `open -a nvim` fails silently because they ship
 *  no .app bundle. They land in Sprint 06 via a secondary PTY preview pane. */
export const MAC_APPS: readonly OpenInApp[] = [
  { id: "vscode",      label: "VS Code",       openWith: "Visual Studio Code", kind: "gui",      icon: Code2,    color: "text-sky-400" },
  { id: "cursor",      label: "Cursor",        openWith: "Cursor",              kind: "gui",      icon: Code2,    color: "text-neutral-200" },
  { id: "windsurf",    label: "Windsurf",      openWith: "Windsurf",            kind: "gui",      icon: Wind,     color: "text-teal-400" },
  { id: "antigravity", label: "Antigravity",   openWith: "Antigravity",         kind: "gui",      icon: Sparkles, color: "text-emerald-400" },
  { id: "zed",         label: "Zed",           openWith: "Zed",                 kind: "gui",      icon: Code2,    color: "text-orange-400" },
  { id: "xcode",       label: "Xcode",         openWith: "Xcode",               kind: "gui",      icon: Hammer,   color: "text-sky-500" },
  { id: "sublime",     label: "Sublime Text",  openWith: "Sublime Text",        kind: "gui",      icon: FileCode, color: "text-amber-400" },
  { id: "textmate",    label: "TextMate",      openWith: "TextMate",            kind: "gui",      icon: FileText, color: "text-neutral-300" },
  { id: "iterm2",      label: "iTerm",         openWith: "iTerm",               kind: "terminal", icon: Terminal, color: "text-emerald-400" },
  { id: "warp",        label: "Warp",          openWith: "Warp",                kind: "terminal", icon: Terminal, color: "text-violet-400" },
  { id: "ghostty",     label: "Ghostty",       openWith: "Ghostty",             kind: "terminal", icon: Terminal, color: "text-fuchsia-400" },
  { id: "terminal",    label: "Terminal",      openWith: "Terminal",            kind: "terminal", icon: Terminal, color: "text-neutral-400" },
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
