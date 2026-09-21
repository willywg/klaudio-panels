import { CLAUDE, type AgentId } from "@/lib/agents";

const PREFIX = "openTabs:";

/** Upper bound on what one project remembers. Restoring is cheap (dormant
 *  tabs hold no PTY) but the strip stops being readable long before this,
 *  and an unbounded list would grow for as long as the project lives. */
export const MAX_REMEMBERED_TABS = 12;

/** Profile-aware but pre-agent key — see `openTabsKey`. */
export function preAgentOpenTabsKey(
  projectPath: string,
  profileId: string,
): string {
  return `${PREFIX}${projectPath}:${profileId}`;
}

export function openTabsKey(
  projectPath: string,
  agentId: AgentId,
  profileId: string,
): string {
  return `${PREFIX}${agentId}:${projectPath}:${profileId}`;
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore — private browsing / quota.
  }
}

/** The ordered session ids that were open for this project the last time it
 *  had tabs, namespaced by agent and profile (decisions #9 and #13) — a
 *  project pinned to another `CLAUDE_CONFIG_DIR`, or driven by another
 *  agent, must never restore someone else's workspace. Anything unparseable
 *  reads as empty rather than throwing into the auto-resume path.
 *
 *  Migrates the pre-agent key on the way, on the same terms as
 *  `getLastSessionId`: constructed, never parsed, and Claude-only because
 *  Claude is the only agent that can have written one. */
export function getOpenTabIds(
  projectPath: string,
  agentId: AgentId,
  profileId: string,
): string[] {
  const key = openTabsKey(projectPath, agentId, profileId);
  const current = parseIds(read(key));
  if (current.length > 0) return current;

  if (agentId !== CLAUDE) return [];

  const preAgentKey = preAgentOpenTabsKey(projectPath, profileId);
  const legacy = parseIds(read(preAgentKey));
  if (legacy.length === 0) return [];
  setOpenTabIds(projectPath, agentId, profileId, legacy);
  return legacy;
}

/** Writes the workspace shape. Callers must not call this with an empty list
 *  to mean "the project has no tabs right now" — closing the last tab, or
 *  closing the project, deliberately leaves the previous list in place so
 *  reopening picks up where the user left off (same contract as
 *  `lastSessionId`, see `App.handleCloseProject`). */
export function setOpenTabIds(
  projectPath: string,
  agentId: AgentId,
  profileId: string,
  sessionIds: string[],
): void {
  const key = openTabsKey(projectPath, agentId, profileId);
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
  } finally {
    // A write settles the question for this (project, agent, profile). The
    // older spelling has to go with it, or clearing the new key later would
    // fall back to a workspace from before the upgrade.
    if (agentId === CLAUDE) drop(preAgentOpenTabsKey(projectPath, profileId));
  }
}
