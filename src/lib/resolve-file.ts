import { invoke } from "@tauri-apps/api/core";

/** Resolutions already computed, keyed by project + path. Bounded because a
 *  long session can click a lot of links; the entries are short strings. */
const resolved = new Map<string, string | null>();
const MAX_CACHED = 200;

/** Key separator. A NUL is the one byte a filesystem path cannot hold, so it
 *  cannot collide with either half of the key. */
const SEP = "\u0000";

/**
 * Turn a path printed in the terminal into one that exists in the project.
 *
 * Claude prints paths relative to *its own* working directory. When the
 * session runs in a sub-project — `construct-ai/ai-service` — a correct
 * `tests/foo.py` is wrong for us, because we resolve against the project root
 * and the prefix is missing. The backend checks the direct path first (a
 * single `stat`, no walk) and only then searches for a file whose relative
 * path ends with what we were given.
 *
 * Falls back to the original path when nothing matches, so a genuinely missing
 * file still opens a preview tab that reports it rather than the click doing
 * nothing at all.
 */
export async function resolveProjectFile(
  projectPath: string,
  rel: string,
): Promise<string> {
  const base = projectPath.endsWith("/")
    ? projectPath.slice(0, -1)
    : projectPath;
  const needle = rel.startsWith("./") ? rel.slice(2) : rel;

  const key = `${base}${SEP}${needle}`;
  const hit = resolved.get(key);
  if (hit !== undefined) return hit ?? needle;

  try {
    const matches = await invoke<string[]>("resolve_project_file", {
      projectPath: base,
      rel: needle,
    });
    const best = matches[0] ?? null;
    remember(key, best);
    return best ?? needle;
  } catch {
    remember(key, null);
    return needle;
  }
}

function remember(key: string, value: string | null): void {
  // Oldest insertion first — Map preserves insertion order, so this is a
  // plain FIFO eviction rather than a true LRU. Good enough for a cache whose
  // only job is to keep a repeated click from re-walking the project.
  if (resolved.size >= MAX_CACHED) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
  resolved.set(key, value);
}
