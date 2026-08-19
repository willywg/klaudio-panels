import { invoke } from "@tauri-apps/api/core";
import { askWhichFile } from "@/lib/file-picker-bus";

/** Candidate lists already computed, keyed by project + path. Bounded because
 *  a long session can click a lot of links; the entries are short strings. */
const candidateCache = new Map<string, string[]>();

/** What the user picked for an ambiguous path, so they are asked once per
 *  path rather than once per click. */
const chosen = new Map<string, string>();

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
 * Three outcomes, and the middle one is the reason this is async:
 *
 *  - **One candidate** — open it. Covers the direct hit and the missing-prefix
 *    case, with no extra step.
 *  - **Several** — ask. `app/main.py` exists under `core/`, `telegram/` and
 *    `whatsapp/`, and nothing in the printed path says which was meant.
 *    Guessing would open a file from the wrong service with no error shown,
 *    and being quietly wrong is worse here than asking once.
 *  - **None** — hand back the original path so the preview reports the missing
 *    file itself, rather than the click doing nothing at all.
 *
 * Returns `null` only when the user dismissed the question.
 */
export async function resolveProjectFile(
  projectPath: string,
  rel: string,
): Promise<string | null> {
  const base = projectPath.endsWith("/")
    ? projectPath.slice(0, -1)
    : projectPath;
  const needle = rel.startsWith("./") ? rel.slice(2) : rel;
  const key = `${base}${SEP}${needle}`;

  const remembered = chosen.get(key);
  if (remembered !== undefined) return remembered;

  const candidates = await candidatesFor(key, base, needle);
  if (candidates.length === 0) return needle;
  if (candidates.length === 1) return candidates[0];

  const pick = await askWhichFile(needle, candidates);
  if (pick === null) return null;
  remember(chosen, key, pick);
  return pick;
}

async function candidatesFor(
  key: string,
  base: string,
  needle: string,
): Promise<string[]> {
  const hit = candidateCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const matches = await invoke<string[]>("resolve_project_file", {
      projectPath: base,
      rel: needle,
    });
    remember(candidateCache, key, matches);
    return matches;
  } catch {
    remember(candidateCache, key, []);
    return [];
  }
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  // Oldest insertion first — Map preserves insertion order, so this is plain
  // FIFO eviction rather than a true LRU. Good enough for a cache whose only
  // job is to keep a repeated click from re-walking the project.
  if (map.size >= MAX_CACHED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
