import type { Extension } from "@codemirror/state";

/** Lazy-loaded language extensions, keyed by file extension. We resolve
 *  one factory per language and cache it so re-opening the same kind of
 *  file is a microtask hit instead of a fresh dynamic import. */
const cache = new Map<string, Promise<Extension | null>>();

function ext(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

async function loadFor(extension: string): Promise<Extension | null> {
  switch (extension) {
    case "ts":
    case "mts":
    case "cts": {
      const m = await import("@codemirror/lang-javascript");
      return m.javascript({ typescript: true });
    }
    case "tsx": {
      const m = await import("@codemirror/lang-javascript");
      return m.javascript({ typescript: true, jsx: true });
    }
    case "js":
    case "mjs":
    case "cjs": {
      const m = await import("@codemirror/lang-javascript");
      return m.javascript({});
    }
    case "jsx": {
      const m = await import("@codemirror/lang-javascript");
      return m.javascript({ jsx: true });
    }
    case "json":
    case "jsonc": {
      const m = await import("@codemirror/lang-json");
      return m.json();
    }
    case "md":
    case "markdown":
    case "mdx": {
      const m = await import("@codemirror/lang-markdown");
      return m.markdown();
    }
    case "css":
    case "scss":
    case "less": {
      const m = await import("@codemirror/lang-css");
      return m.css();
    }
    case "html":
    case "htm":
    case "xhtml":
    case "svg": {
      const m = await import("@codemirror/lang-html");
      return m.html();
    }
    case "rs": {
      const m = await import("@codemirror/lang-rust");
      return m.rust();
    }
    case "py":
    case "pyi": {
      const m = await import("@codemirror/lang-python");
      return m.python();
    }
    case "yml":
    case "yaml": {
      const m = await import("@codemirror/lang-yaml");
      return m.yaml();
    }
    case "sql": {
      const m = await import("@codemirror/lang-sql");
      return m.sql();
    }
    default:
      return null;
  }
}

export function languageExtensionFor(
  path: string,
): Promise<Extension | null> {
  const e = ext(path);
  if (!e) return Promise.resolve(null);
  let p = cache.get(e);
  if (!p) {
    p = loadFor(e);
    cache.set(e, p);
  }
  return p;
}

const BINARY_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "ico",
  "icns",
  "pdf",
  "zip",
  "gz",
  "tar",
  "bz2",
  "xz",
  "7z",
  "rar",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "webm",
  "ogg",
  "wav",
  "flac",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "exe",
  "dll",
  "so",
  "dylib",
  "class",
  "jar",
  "wasm",
  "psd",
  "sketch",
]);

/** Cheap up-front check the file tree menu uses to decide whether to render
 *  the "Edit" item disabled. The Rust read path is still authoritative —
 *  this just avoids round-tripping for the obvious cases. */
export function looksBinaryByExtension(path: string): boolean {
  return BINARY_EXTS.has(ext(path));
}
