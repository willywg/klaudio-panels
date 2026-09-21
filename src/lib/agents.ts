/** The frontend's half of the agent registry (`src-tauri/src/agent.rs`).
 *
 *  Deliberately thin: argv, binary discovery and session storage all live in
 *  Rust, so this side only ever needs to *name* an agent — to tag a tab, to
 *  namespace a storage key, and to ask the backend which one to spawn. There
 *  is no mirrored table of flags here to drift out of sync with the real one.
 */

export const CLAUDE = "claude";

/** Every agent the app can currently offer. One entry until the Cursor
 *  provider lands; the picker that reads this arrives with it. */
export const AGENT_IDS = [CLAUDE] as const;

export type AgentId = (typeof AGENT_IDS)[number];

/** The agent a tab belongs to when nothing says otherwise — including every
 *  tab and stored key written before agents existed, which is why the
 *  storage migration can assume it (see `components/last-session.ts`). */
export const DEFAULT_AGENT: AgentId = CLAUDE;
