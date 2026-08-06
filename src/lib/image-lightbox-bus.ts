import { createSignal } from "solid-js";

/** Which image the full-screen lightbox is showing, if any.
 *
 *  A signal bus rather than context (mirrors `selected-file-bus`) because the
 *  openers are scattered — a terminal link provider, the file preview, the
 *  diff panel — and threading a prop through all of them to reach a single
 *  app-root overlay buys nothing. One lightbox is mounted at a time, so a
 *  single global slot is enough. */

const [openPath, setOpenPath] = createSignal<string | null>(null);

export { openPath as lightboxPath };

/** `path` is absolute (or `~`-prefixed — Rust expands it). */
export function openImageLightbox(path: string): void {
  setOpenPath(path);
}

export function closeImageLightbox(): void {
  setOpenPath(null);
}
