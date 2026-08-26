import { displayLabel, type SessionLike } from "@/lib/session-label";

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
