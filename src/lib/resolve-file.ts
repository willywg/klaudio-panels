import { invoke } from "@tauri-apps/api/core";
import { askWhichFile } from "@/lib/file-picker-bus";

/** Candidate lists already computed, keyed by project + path. Bounded because
 *  a long session can click a lot of links; the entries are short strings. */
const candidateCache = new Map<string, string[]>();

const MAX_CACHED = 200;

/** Key separator. A NUL is the one byte a filesystem path cannot hold, so it
 *  cannot collide with either half of the key. */
const SEP = "\u0000";

/** Strip a trailing slash so `${base}/${rel}` never doubles up. */
export function projectBase(projectPath: string): string {
  return projectPath.endsWith("/") ? projectPath.slice(0, -1) : projectPath;
}

/** The path as the backend wants it: no `./` prefix, nothing else touched. */
export function needleOf(rel: string): string {
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

/** True for a path that already says where it lives, so no project is needed
 *  to interpret it. Tilde expansion happens host-side. */
export function isAbsoluteish(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/");
}

/**
 * Every file in the project whose relative path ends with `rel`, best-first.
 *
 * The one place that asks the backend where a printed path really lives —
 * source files and images alike. Keeping two resolvers with their own ranking
 * and their own caches is precisely how images kept the bug that files had
 * already had fixed (#83).
 *
 * An empty array means nothing matched, including the case where the backend
 * refused the path outright (traversal, no such project). Callers decide what
 * that should look like; this only reports.
 */
export async function projectFileCandidates(
  projectPath: string,
  rel: string,
): Promise<string[]> {
  const base = projectBase(projectPath);
  const needle = needleOf(rel);
  const key = `${base}${SEP}${needle}`;

  const hit = candidateCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const matches = await invoke<string[]>("resolve_project_file", {
      projectPath: base,
      rel: needle,
    });
    remember(key, matches);
    return matches;
  } catch {
    remember(key, []);
    return [];
  }
}

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
 *  - **Several** — ask, every time. `app/main.py` exists under `core/`,
 *    `telegram/` and `whatsapp/`, and nothing in the printed path says which
 *    was meant. Guessing would open a file from the wrong service with no
 *    error shown, and being quietly wrong is worse here than asking.
 *  - **None** — hand back the original path so the preview reports the missing
 *    file itself, rather than the click doing nothing at all.
 *
 * An absolute or `~/` path skips all of it: it already says where it lives,
 * and the preview reads it directly (`resolve_readable`, #85).
 *
 * Returns `null` only when the user dismissed the question.
 */
export async function resolveProjectFile(
  projectPath: string,
  rel: string,
): Promise<string | null> {
  if (isAbsoluteish(rel)) return rel;
  const needle = needleOf(rel);
  const candidates = await projectFileCandidates(projectPath, rel);
  if (candidates.length === 0) return needle;
  if (candidates.length === 1) return candidates[0];

  // Deliberately not remembered. The picker exists so an ambiguous path never
  // opens the wrong file without saying so, and a remembered answer is
  // silent — it would reintroduce the exact failure the picker prevents, just
  // one click later. Ambiguous paths are rare enough that asking each time
  // costs little.
  return askWhichFile(needle, candidates);
}

function remember(key: string, value: string[]): void {
  // Oldest insertion first — Map preserves insertion order, so this is plain
  // FIFO eviction rather than a true LRU. Good enough for a cache whose only
  // job is to keep a repeated click from re-walking the project.
  if (candidateCache.size >= MAX_CACHED) {
    const oldest = candidateCache.keys().next().value;
    if (oldest !== undefined) candidateCache.delete(oldest);
  }
  candidateCache.set(key, value);
}
