import { createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-solid";
import { displayLabel } from "@/lib/session-label";
import { AGENT_DISPLAY, sessionKey, type AgentId } from "@/lib/agents";
import {
  mergeSessionListings,
  type AgentListing,
  type MergedListing,
} from "@/lib/merge-sessions";
import { AgentBadge } from "@/components/agent-badge";

export type SessionMeta = {
  id: string;
  /** Set by the provider that produced this row, never inferred here — with
   *  more than one agent this list becomes a merge of several. */
  agent: AgentId;
  created_at: string | null;
  updated_at: string | null;
  first_message_preview: string | null;
  custom_title: string | null;
  summary: string | null;
  project_path: string;
};

/** Every enabled agent's sessions for a project, merged into one list. Each
 *  provider is asked separately so that one failing — Claude's fails closed
 *  on a direnv error — surfaces as an error of its own instead of blanking
 *  the rest (see `mergeSessionListings`). Shared by the Sessions tab and the
 *  command palette so both agree on what a project's sessions are. */
export async function listProjectSessions(
  projectPath: string,
  agentIds: readonly AgentId[],
): Promise<MergedListing<SessionMeta>> {
  const listings = await Promise.all(
    agentIds.map(async (agent): Promise<AgentListing<SessionMeta>> => {
      try {
        const sessions = (await invoke("list_sessions_for_project", {
          projectPath,
          agentId: agent,
        })) as SessionMeta[];
        return { agent, ok: true, sessions };
      } catch (err) {
        return { agent, ok: false, error: String(err) };
      }
    }),
  );
  return mergeSessionListings(listings);
}

export function SessionsList(props: {
  projectPath: string;
  agentIds: readonly AgentId[];
  /** Badge each row with its agent. On only when there is a choice. */
  showAgent: boolean;
  /** `sessionKey(agent, id)` of the active tab's session. */
  activeSessionKey: string | null;
  openSessionKeys: Set<string>;
  openingSessionKeys: Set<string>;
  onNew: (e: MouseEvent) => void;
  onSelect: (s: SessionMeta) => void;
  onRefresh: () => void;
  refreshKey: number;
}) {
  const [listing] = createResource(
    () => ({ path: props.projectPath, agents: props.agentIds, _k: props.refreshKey }),
    ({ path, agents }) => listProjectSessions(path, agents),
  );
  const sessions = () => listing()?.sessions;

  return (
    <div class="h-full flex flex-col">
      <button
        class="m-3 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded text-sm font-medium"
        onClick={(e) => props.onNew(e)}
      >
        + New session
      </button>

      <div class="px-3 mb-1 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-neutral-500">
          Sessions
        </span>
        <button
          class="p-1 text-neutral-500 hover:text-neutral-200 rounded transition"
          onClick={props.onRefresh}
          title="Refresh list"
        >
          <RefreshCw
            size={12}
            strokeWidth={2}
            class={listing.loading ? "animate-spin" : ""}
          />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto">
        <Show when={listing.loading && !listing.latest}>
          <div class="px-3 py-2 text-xs text-neutral-500">Loading…</div>
        </Show>
        <Show when={listing.error}>
          <div class="px-3 py-2 text-xs text-red-400">
            Error: {String(listing.error)}
          </div>
        </Show>
        <For each={listing()?.errors ?? []}>
          {(e) => (
            <div class="px-3 py-2 text-xs text-red-400 break-words">
              <span class="font-medium">{AGENT_DISPLAY[e.agent].name}:</span>{" "}
              {e.error}
            </div>
          )}
        </For>
        <Show when={sessions() && sessions()!.length === 0}>
          <div class="px-3 py-2 text-xs text-neutral-500">
            No previous sessions for this project.
          </div>
        </Show>

        <For each={sessions() ?? []}>
          {(s) => {
            const key = sessionKey(s.agent, s.id);
            const isActive = () => props.activeSessionKey === key;
            const isOpen = () => props.openSessionKeys.has(key);
            const isOpening = () => props.openingSessionKeys.has(key);
            const label = () => displayLabel(s);
            return (
              <button
                onClick={() => !isOpening() && props.onSelect(s)}
                disabled={isOpening()}
                class={
                  "w-full text-left px-3 py-2 border-l-2 flex gap-2 items-start disabled:cursor-wait " +
                  (isActive()
                    ? "border-indigo-500 bg-neutral-900"
                    : isOpen()
                      ? "border-green-600/60 hover:bg-neutral-900/50"
                      : "border-transparent hover:bg-neutral-900/50")
                }
                title={isOpen() ? "Open in a tab" : undefined}
              >
                <span
                  class={
                    "mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 " +
                    (isOpening()
                      ? "bg-indigo-400 animate-pulse"
                      : isOpen()
                        ? "bg-green-500"
                        : "bg-transparent")
                  }
                />
                <span class="flex-1 min-w-0">
                  <div class="flex items-center gap-1.5 text-[11px] text-neutral-500 font-mono">
                    <span class="truncate">{formatTs(s.updated_at ?? s.created_at)}</span>
                    <Show when={props.showAgent}>
                      <AgentBadge agent={s.agent} />
                    </Show>
                  </div>
                  <div class="text-xs text-neutral-200 line-clamp-2 mt-0.5">
                    {label()}
                  </div>
                </span>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

function formatTs(ts: string | null): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  } catch {
    return ts;
  }
}
