/** The frontend's half of the agent registry (`src-tauri/src/agent.rs`).
 *
 *  Deliberately thin: argv, binary discovery and session storage all live in
 *  Rust, so this side only ever needs to *name* an agent — to tag a tab, to
 *  namespace a storage key, to badge a row, and to ask the backend which one
 *  to spawn. There is no mirrored table of flags here to drift out of sync
 *  with the real one.
 */

export const CLAUDE = "claude";
export const CURSOR = "cursor";

/** Every agent this build knows, in the order they are offered. Whether one
 *  is *enabled* is a setting the backend owns (`context/agents.tsx`). */
export const AGENT_IDS = [CLAUDE, CURSOR] as const;

export type AgentId = (typeof AGENT_IDS)[number];

/** The agent a tab belongs to when nothing says otherwise — including every
 *  tab and stored key written before agents existed, which is why the
 *  storage migration can assume it (see `components/last-session.ts`). */
export const DEFAULT_AGENT: AgentId = CLAUDE;

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === "string" && (AGENT_IDS as readonly string[]).includes(v);
}

/** How an agent is shown. Both names start with a C, so the compact badge
 *  uses two letters rather than an initial that would say nothing. */
export const AGENT_DISPLAY: Record<
  AgentId,
  {
    name: string;
    /** The product, for sentences like "Starting Claude Code…". */
    product: string;
    /** The executable, for messages about the process itself. */
    bin: string;
    short: string;
    badgeClass: string;
  }
> = {
  claude: {
    name: "Claude",
    product: "Claude Code",
    bin: "claude",
    short: "Cl",
    badgeClass: "text-orange-300 bg-orange-500/10 border-orange-500/30",
  },
  cursor: {
    name: "Cursor",
    product: "Cursor",
    bin: "cursor-agent",
    short: "Cu",
    badgeClass: "text-sky-300 bg-sky-500/10 border-sky-500/30",
  },
};

/** A session id is each agent's own, so two agents can mint the same one.
 *  Anything that keys a session outside a single agent's list keys it by
 *  both. */
export function sessionKey(agent: AgentId, sessionId: string): string {
  return `${agent}:${sessionId}`;
}
