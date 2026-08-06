import { invoke } from "@tauri-apps/api/core";

/** Kept in lockstep with `IMAGE_EXTENSIONS` in `src-tauri/src/file_read.rs`.
 *  The Rust side is the one that enforces it — this copy only decides which
 *  UI affordance to offer, so a drift makes a link inert, never unsafe. */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
]);

export function isImagePath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export type ImagePayload = {
  /** Canonical absolute path, tilde already expanded host-side. */
  path: string;
  mime: string;
  /** base64 of the raw file. */
  data: string;
  bytes: number;
};

/** Hovering a link and then clicking it asks for the same file twice, and a
 *  hover can re-fire on every mouse move — cache by the path we were asked
 *  for. Bounded because payloads are base64 and fat. */
const CACHE_LIMIT = 12;
const cache = new Map<string, ImagePayload>();

export async function loadImage(path: string): Promise<ImagePayload> {
  const hit = cache.get(path);
  if (hit) {
    // Refresh recency: re-inserting moves it to the end of the Map order.
    cache.delete(path);
    cache.set(path, hit);
    return hit;
  }
  const payload = await invoke<ImagePayload>("read_image", { path });
  cache.set(path, payload);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return payload;
}

/** Drop a cached entry so the next read hits disk. Called when the file
 *  watcher reports the image changed under us. */
export function invalidateImage(path: string): void {
  cache.delete(path);
}

export function imageDataUrl(payload: ImagePayload): string {
  return `data:${payload.mime};base64,${payload.data}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
