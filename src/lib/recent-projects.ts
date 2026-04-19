export type RecentProject = {
  path: string;
  lastOpened: number; // epoch ms
  /** Whether the project shows in the sidebar. Home always shows all. */
  pinned: boolean;
};

export const RECENT_PROJECTS_KEY = "recentProjects";
export const MAX_RECENT_PROJECTS = 20;

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
        // Backward compat: entries persisted before pinning existed default to pinned.
        return {
          path: raw.path!,
          lastOpened: raw.lastOpened!,
          pinned: raw.pinned === undefined ? true : !!raw.pinned,
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

export function projectInitial(path: string): string {
  return projectLabel(path).slice(0, 1).toUpperCase();
}

/** "hace 3 s", "hace 5 min", "hace 2 h", "hace 3 d". */
export function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} d`;
}
