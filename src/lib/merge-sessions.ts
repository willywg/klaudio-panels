import type { AgentId } from "@/lib/agents";

type Listed = {
  id: string;
  agent: AgentId;
  created_at: string | null;
  updated_at: string | null;
};

export type AgentListing<T extends Listed> =
  | { agent: AgentId; ok: true; sessions: T[] }
  | { agent: AgentId; ok: false; error: string };

export type MergedListing<T extends Listed> = {
  sessions: T[];
  /** One entry per provider that failed, in agent order. Rendered inline so
   *  a failure is visible without taking the other agents' rows with it. */
  errors: { agent: AgentId; error: string }[];
};

function ts(v: string | null): number {
  if (!v) return Number.NEGATIVE_INFINITY;
  const n = Date.parse(v);
  return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n;
}

/** Merges each agent's session listing into the one list the Sessions tab
 *  shows. The question the list answers is "what was I doing in this
 *  project", not "which CLI", so rows interleave by recency.
 *
 *  A provider that failed contributes an error instead of rows, and never
 *  blanks the others. That is the whole reason this is a merge of results
 *  rather than one call that fails as a unit: Claude's provider fails closed
 *  on a direnv error (decision #13), which is right when it is alone and
 *  wrong when it would hide every Cursor chat along with it.
 *
 *  Ordering mirrors both backends — `updated_at` desc, then `created_at`
 *  desc — with agent then id as the tie-breakers, so two rows that tie on
 *  time cannot swap places between refreshes. */
export function mergeSessionListings<T extends Listed>(
  listings: AgentListing<T>[],
): MergedListing<T> {
  const sessions: T[] = [];
  const errors: { agent: AgentId; error: string }[] = [];
  for (const l of listings) {
    if (l.ok) sessions.push(...l.sessions);
    else errors.push({ agent: l.agent, error: l.error });
  }
  sessions.sort(
    (a, b) =>
      ts(b.updated_at) - ts(a.updated_at) ||
      ts(b.created_at) - ts(a.created_at) ||
      a.agent.localeCompare(b.agent) ||
      a.id.localeCompare(b.id),
  );
  return { sessions, errors };
}
