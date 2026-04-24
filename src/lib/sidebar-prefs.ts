export type SidebarTab = "sessions" | "files";

const COLLAPSED_KEY = "sidebarCollapsed";
const TAB_KEY_PREFIX = "sidebarTab:";
const WIDTH_KEY_PREFIX = "sidebarWidth:";

export function getCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCollapsed(v: boolean): void {
  try {
    if (v) localStorage.setItem(COLLAPSED_KEY, "1");
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // ignore
  }
}

export function getActiveTab(projectPath: string): SidebarTab {
  try {
    const v = localStorage.getItem(TAB_KEY_PREFIX + projectPath);
    return v === "files" ? "files" : "sessions";
  } catch {
    return "sessions";
  }
}

export function setActiveTab(projectPath: string, tab: SidebarTab): void {
  try {
    localStorage.setItem(TAB_KEY_PREFIX + projectPath, tab);
  } catch {
    // ignore
  }
}

export function getSidebarWidth(projectPath: string): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_KEY_PREFIX + projectPath);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setSidebarWidth(projectPath: string, px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY_PREFIX + projectPath, String(Math.round(px)));
  } catch {
    // ignore
  }
}
