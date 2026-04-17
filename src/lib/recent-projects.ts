import { createSignal } from "solid-js";

const KEY = "recentProjects";
const MAX = 10;

export type RecentProject = {
  path: string;
  lastOpened: number; // epoch ms
};

function load(): RecentProject[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p: unknown): p is RecentProject =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as RecentProject).path === "string" &&
        typeof (p as RecentProject).lastOpened === "number",
    );
  } catch {
    return [];
  }
}

function save(list: RecentProject[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

const [recents, setRecents] = createSignal<RecentProject[]>(load());

export function getRecentProjects(): RecentProject[] {
  return recents();
}

export const recentProjectsSignal = recents;

export function touchProject(path: string): void {
  const now = Date.now();
  const filtered = recents().filter((p) => p.path !== path);
  const next = [{ path, lastOpened: now }, ...filtered].slice(0, MAX);
  setRecents(next);
  save(next);
}

export function removeProject(path: string): void {
  const next = recents().filter((p) => p.path !== path);
  setRecents(next);
  save(next);
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
  const label = projectLabel(path);
  return label.slice(0, 1).toUpperCase();
}

/** Relative time string: "hace 3 segundos", "hace 5 min", "hace 2 h", "hace 3 d". */
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
