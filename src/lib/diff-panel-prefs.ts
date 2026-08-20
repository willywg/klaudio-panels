const OPEN_PREFIX = "diffPanelOpen:";
const WIDTH_PREFIX = "diffPanelWidth:";

export function getDiffPanelOpen(projectPath: string): boolean {
  try {
    return localStorage.getItem(OPEN_PREFIX + projectPath) === "1";
  } catch {
    return false;
  }
}

export function setDiffPanelOpen(projectPath: string, v: boolean): void {
  try {
    if (v) localStorage.setItem(OPEN_PREFIX + projectPath, "1");
    else localStorage.removeItem(OPEN_PREFIX + projectPath);
  } catch {
    // ignore
  }
}

export function getDiffPanelWidth(projectPath: string): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_PREFIX + projectPath);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setDiffPanelWidth(projectPath: string, px: number): void {
  try {
    localStorage.setItem(WIDTH_PREFIX + projectPath, String(Math.round(px)));
  } catch {
    // ignore
  }
}

const COMMIT_MESSAGE_HEIGHT = "commitMessageHeight";

/** How much room a commit message gets before it scrolls, in px.
 *
 *  Not keyed by project: it says how much of a commit message you want to
 *  read at a glance, which is about you and not about the repo. */
export function getCommitMessageHeight(): number | null {
  try {
    const raw = localStorage.getItem(COMMIT_MESSAGE_HEIGHT);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setCommitMessageHeight(px: number): void {
  try {
    localStorage.setItem(COMMIT_MESSAGE_HEIGHT, String(Math.round(px)));
  } catch {
    // ignore
  }
}
