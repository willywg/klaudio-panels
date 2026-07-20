import { createSignal } from "solid-js";

/** Global Source|Rendered preference for markdown file previews. One knob
 *  for the whole app (persisted): flipping it affects every open markdown
 *  preview, which matches the "reading mode" mental model better than a
 *  per-tab switch users would have to keep re-toggling. */

export type MdPreviewMode = "rendered" | "source";

const STORAGE_KEY = "markdownPreviewMode";

function readInitial(): MdPreviewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "source" ? "source" : "rendered";
  } catch {
    return "rendered";
  }
}

const [mode, setMode] = createSignal<MdPreviewMode>(readInitial());

export const markdownPreviewMode = mode;

export function setMarkdownPreviewMode(next: MdPreviewMode): void {
  setMode(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore — quota / private mode
  }
}

export function toggleMarkdownPreviewMode(): void {
  setMarkdownPreviewMode(mode() === "rendered" ? "source" : "rendered");
}

const MD_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

export function isMarkdownPath(relPath: string): boolean {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  return MD_EXTENSIONS.has(ext);
}
