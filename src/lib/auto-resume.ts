import { displayLabel, type SessionLike } from "@/lib/session-label";
import { CLAUDE, type AgentId } from "@/lib/agents";

export type ResumeSource = "namespaced" | "legacy";

export type AutoResumeDecision =
  | { action: "none" }
  | { action: "open"; source: ResumeSource; sessionId: string; label: string }
  | { action: "stale"; source: ResumeSource };

export type AutoResumeDeps = {
  getNamespaced: () => string | null;
  /** Only ever called for Claude on `profileId === "default"`, and only
   *  when the namespaced lookup was empty. A custom profile — or any other
   *  agent — must never read the legacy key: it predates both namespaces,
   *  so its value can only have come from Claude's default profile. */
  getLegacy: () => string | null;
  listSessions: () => Promise<SessionLike[]>;
};

/** Pure decision for whether/how to auto-resume a project on open. Kept
 *  free of Tauri/Solid so the required outcomes (namespaced open/stale,
 *  legacy open/stale-with-migration, listing-error, and neither a custom
 *  profile nor a non-Claude agent ever touching the legacy key) can be unit
 *  tested directly. The caller (App.tsx) is
 *  responsible for acting on the decision — writing/clearing storage keys
 *  and opening the tab. */
export async function resolveAutoResumeTarget(
  agentId: AgentId,
  profileId: string,
  deps: AutoResumeDeps,
): Promise<AutoResumeDecision> {
  let candidate = deps.getNamespaced();
  let source: ResumeSource = "namespaced";

  if (!candidate && agentId === CLAUDE && profileId === "default") {
    candidate = deps.getLegacy();
    source = "legacy";
  }

  if (!candidate) return { action: "none" };

  let sessions: SessionLike[];
  try {
    sessions = await deps.listSessions();
  } catch {
    // Transient/blocked-.envrc territory — abort without touching either
    // stored pointer, since we can't tell "gone" from "not checkable yet".
    return { action: "none" };
  }

  const meta = sessions.find((s) => s.id === candidate);
  if (!meta) {
    return { action: "stale", source };
  }
  return { action: "open", source, sessionId: candidate, label: displayLabel(meta) };
}
