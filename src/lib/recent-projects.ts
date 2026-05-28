export type RecentProject = {
  path: string;
  lastOpened: number; // epoch ms
  /** Whether the project shows in the sidebar. Home always shows all. */
  pinned: boolean;
  /** User override for the avatar initials. 1–3 chars, already trimmed and
   *  upper-cased on write. When undefined, projectInitial() computes them
   *  automatically from the path. */
  customInitials?: string;
};

export const RECENT_PROJECTS_KEY = "recentProjects";
export const MAX_RECENT_PROJECTS = 20;
export const MAX_CUSTOM_INITIALS = 3;

/** Sanitize a user-supplied initials override. Returns undefined to clear
 *  the override (empty string after trim). Caller persists via the projects
 *  context which routes through saveRecentProjects. */
export function sanitizeCustomInitials(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_CUSTOM_INITIALS).toUpperCase();
}

export function loadRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p: unknown) => {
        if (
          typeof p !== "object" ||
          p === null ||
          typeof (p as RecentProject).path !== "string" ||
          typeof (p as RecentProject).lastOpened !== "number"
        ) {
          return null;
        }
        const raw = p as Partial<RecentProject>;
        const customInitials =
          typeof raw.customInitials === "string"
            ? sanitizeCustomInitials(raw.customInitials)
            : undefined;
        // Backward compat: entries persisted before pinning existed default to pinned.
        return {
          path: raw.path!,
          lastOpened: raw.lastOpened!,
          pinned: raw.pinned === undefined ? true : !!raw.pinned,
          ...(customInitials ? { customInitials } : {}),
        } satisfies RecentProject;
      })
      .filter((p): p is RecentProject => p !== null);
  } catch {
    return [];
  }
}

export function saveRecentProjects(list: RecentProject[]): void {
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list));
  } catch {
    // ignore — quota / private mode
  }
}

export function projectLabel(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs[segs.length - 1] || path;
}

/** Deterministic HSL color from a path, for avatar tiles. */
export function projectColor(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash * 31 + path.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 50%, 42%)`;
}

/** Two-letter avatar initials for the project. Splits the folder name on
 *  separators (_, -, ., space) and camelCase boundaries; multi-word names
 *  take the first letter of the first two words (platform_two → "PT"), while
 *  single-word names take the first two characters (Perfil → "PE"). Callers
 *  may pass a `customInitials` override (already sanitized) to short-circuit
 *  the algorithm. */
export function projectInitial(
  path: string,
  customInitials?: string,
): string {
  if (customInitials && customInitials.length > 0) return customInitials;
  const label = projectLabel(path);
  const words = label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._\-]+/)
    .filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return label.slice(0, 2).toUpperCase();
}

/** "3 s ago", "5 min ago", "2 h ago", "3 d ago". */
export function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}
