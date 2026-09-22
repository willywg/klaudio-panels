import { displayLabel, type SessionLike } from "@/lib/session-label";
import type { AgentId } from "@/lib/agents";

export type RestoredTab = { sessionId: string; label: string };

/** Turns the remembered session ids into the tab strip to rebuild on reopen.
 *
 *  Labels come from the live session listing rather than from storage, so a
 *  `/rename` that happened while the app was closed shows up, and an id whose
 *  session no longer exists is dropped instead of becoming a tab that would
 *  fail the moment it's woken.
 *
 *  `wakeSessionId` is the one tab that gets a PTY immediately (the session
 *  that was active at quit). It keeps its stored position; if it isn't in the
 *  stored list at all — a legacy `lastSessionId` from before workspaces were
 *  remembered, or a tab correlated after the last write — it leads.
 *
 *  Pure so the ordering, de-duplication and staleness rules can be tested
 *  without a store or localStorage. */
export function resolveRestoredTabs(
  storedIds: string[],
  sessions: SessionLike[],
  wakeSessionId: string | null,
): RestoredTab[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out: RestoredTab[] = [];
  const seen = new Set<string>();

  for (const id of storedIds) {
    if (seen.has(id)) continue;
    const meta = byId.get(id);
    if (!meta) continue;
    seen.add(id);
    out.push({ sessionId: id, label: displayLabel(meta) });
  }

  if (wakeSessionId && !seen.has(wakeSessionId)) {
    const meta = byId.get(wakeSessionId);
    if (meta) {
      out.unshift({ sessionId: wakeSessionId, label: displayLabel(meta) });
    }
  }

  return out;
}

export type RestoreGroup = {
  agentId: AgentId;
  restored: RestoredTab[];
  /** The session this agent would wake on its own — its `lastSessionId`,
   *  validated — or null when it only has remembered tabs. */
  wanted: string | null;
};

/** With more than one agent, reopening a project can rebuild tabs for each
 *  of them, but only one tab gets a PTY (decision #9). This picks it.
 *
 *  The agent the user was last in wins, when it has anything to restore.
 *  Otherwise the first group in registry order — the same answer a
 *  single-agent install always got. Within the chosen group, its own
 *  remembered session wins, else its first surviving tab, so the pane is
 *  never blank.
 *
 *  Pure: ordering across agents and the fallback when the last agent has
 *  nothing left are the parts worth testing without a store. */
export function chooseWakeTarget(
  groups: RestoreGroup[],
  lastAgent: AgentId | null,
): { groupIndex: number; sessionId: string } | null {
  const usable = groups
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => g.restored.length > 0);
  if (usable.length === 0) return null;
  const pick = usable.find(({ g }) => g.agentId === lastAgent) ?? usable[0];
  return {
    groupIndex: pick.i,
    sessionId: pick.g.wanted ?? pick.g.restored[0].sessionId,
  };
}
