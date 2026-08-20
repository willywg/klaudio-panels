import { invoke } from "@tauri-apps/api/core";
import { askWhichFile } from "@/lib/file-picker-bus";
import {
  isAbsoluteish,
  needleOf,
  projectBase,
  projectFileCandidates,
} from "@/lib/resolve-file";

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

// Lives in `resolve-file` now that text files ask the same question images
// always did; re-exported here so the existing importers keep working.
export { isAbsoluteish } from "@/lib/resolve-file";

export type ResolveImageOpts = {
  /** Ask the user which file when several match. Only a click may set this:
   *  a hover has to answer instantly and silently, so it takes the best
   *  candidate and lives with being a guess for the length of a thumbnail. */
  ask?: boolean;
};

/** Turn a token matched in the terminal into a path `read_image` can open.
 *
 *  Four shapes turn up:
 *    - `~/shots/a.png`, `/tmp/a.png` — already absolute; hand back as-is,
 *      since `read_image` deliberately reads from anywhere on disk (#73).
 *    - `../assets/a.png` — escapes the project, so the suffix search can't
 *      speak about it. Join it and let `read_image` canonicalize.
 *    - `app/assets/images/logo.png` — looks project-relative, and used to be
 *      joined onto the root unconditionally. That is wrong the moment the
 *      session runs in a sub-project: Claude prints paths relative to *its*
 *      cwd, so the real file is `web/app/assets/images/logo.png` and the
 *      joined path simply doesn't exist (#83).
 *    - `logo.png` — a bare name, which is how Claude lists images most of
 *      the time. `<project>/logo.png` almost never exists either.
 *
 *  The last two are the same question — where does this path really live? —
 *  so they go through the same resolver as source files. It checks the direct
 *  path first (one `stat`) and only then walks.
 *
 *  Returns `null` when nothing matches or the user dismissed the picker, so
 *  callers can stay quiet instead of reporting a failure the user can't act
 *  on.
 */
export async function resolveImagePath(
  projectPath: string,
  token: string,
  opts: ResolveImageOpts = {},
): Promise<string | null> {
  if (isAbsoluteish(token)) return token;

  const base = projectBase(projectPath);
  const rel = needleOf(token);
  // A traversal segment leaves the project, which is exactly what the suffix
  // search refuses to reason about. `read_image` isn't project-scoped, so the
  // plain join still opens it when it exists.
  if (rel.split("/").includes("..")) return `${base}/${rel}`;

  const candidates = await projectFileCandidates(base, rel);
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || !opts.ask) return `${base}/${candidates[0]}`;

  const choice = await askWhichFile(rel, candidates);
  return choice === null ? null : `${base}/${choice}`;
}

/** Express an absolute path relative to a project when it lives inside it.
 *  Keeps preview tabs on the project-relative paths every other caller uses,
 *  and leaves outside-the-project images absolute. */
export function relativizeToProject(
  projectPath: string,
  absPath: string,
): string {
  const base = projectPath.endsWith("/")
    ? projectPath.slice(0, -1)
    : projectPath;
  return absPath.startsWith(`${base}/`)
    ? absPath.slice(base.length + 1)
    : absPath;
}

export function imageDataUrl(payload: ImagePayload): string {
  return `data:${payload.mime};base64,${payload.data}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
