const PREFIX = "openTabs:";

/** Upper bound on what one project remembers. Restoring is cheap (dormant
 *  tabs hold no PTY) but the strip stops being readable long before this,
 *  and an unbounded list would grow for as long as the project lives. */
export const MAX_REMEMBERED_TABS = 12;

export function openTabsKey(projectPath: string, profileId: string): string {
  return `${PREFIX}${projectPath}:${profileId}`;
}

/** The ordered session ids that were open for this project the last time it
 *  had tabs. Namespaced by profile like `lastSessionId` (decision #13) — a
 *  project pinned to another `CLAUDE_CONFIG_DIR` must never restore the
 *  default profile's workspace. Anything unparseable reads as empty rather
 *  than throwing into the auto-resume path. */
export function getOpenTabIds(projectPath: string, profileId: string): string[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(openTabsKey(projectPath, profileId));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/** Writes the workspace shape. Callers must not call this with an empty list
 *  to mean "the project has no tabs right now" — closing the last tab, or
 *  closing the project, deliberately leaves the previous list in place so
 *  reopening picks up where the user left off (same contract as
 *  `lastSessionId`, see `App.handleCloseProject`). */
export function setOpenTabIds(
  projectPath: string,
  profileId: string,
  sessionIds: string[],
): void {
  const key = openTabsKey(projectPath, profileId);
  try {
    if (sessionIds.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(
      key,
      JSON.stringify(sessionIds.slice(0, MAX_REMEMBERED_TABS)),
    );
  } catch {
    // ignore — private browsing / quota.
  }
}
