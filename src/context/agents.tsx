import {
  createContext,
  createMemo,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { AGENT_IDS, DEFAULT_AGENT, isAgentId, type AgentId } from "@/lib/agents";

/** One agent as `list_agents` reports it. `enabled` and `binaryPath` are
 *  owned by the backend (`agent_settings.rs`, decision #6) because they gate
 *  process spawning; this store only mirrors them. */
export type AgentInfo = {
  id: AgentId;
  displayName: string;
  binName: string;
  enabled: boolean;
  binaryPath: string | null;
};

/** What the UI assumes before `list_agents` answers: Claude on, everything
 *  else off. That is exactly a pre-024 install, so the first frame never
 *  offers an agent the user has not turned on — and anything that must know
 *  for sure (auto-resume) waits on `ready` instead of reading this. */
function assumed(): AgentInfo[] {
  return AGENT_IDS.map((id) => ({
    id,
    displayName: id,
    binName: id,
    enabled: id === DEFAULT_AGENT,
    binaryPath: null,
  }));
}

function makeAgentsContext() {
  const [agents, setAgents] = createSignal<AgentInfo[]>(assumed());

  async function refresh(): Promise<void> {
    try {
      const list = await invoke<AgentInfo[]>("list_agents");
      setAgents(list.filter((a) => isAgentId(a.id)));
    } catch (err) {
      console.warn("list_agents failed", err);
    }
  }

  const ready = refresh();

  const enabled = createMemo(() => agents().filter((a) => a.enabled));
  const enabledIds = createMemo(() => enabled().map((a) => a.id));

  /** More than one agent to choose from. Everything that exists only
   *  because there is a choice — the `+` picker, agent badges on rows and
   *  tabs — is gated on this, so nobody running one agent pays for it. */
  const multiple = createMemo(() => enabled().length > 1);

  /** The agent a new session gets when nothing more specific applies: the
   *  first enabled one, in registry order. */
  const preferred: Accessor<AgentId> = createMemo(
    () => enabled()[0]?.id ?? DEFAULT_AGENT,
  );

  function isEnabled(id: AgentId): boolean {
    return enabled().some((a) => a.id === id);
  }

  async function save(
    id: AgentId,
    settings: { enabled: boolean; binaryPath: string | null },
  ): Promise<void> {
    await invoke("set_agent_settings", {
      agentId: id,
      enabled: settings.enabled,
      binaryPath: settings.binaryPath,
    });
    await refresh();
  }

  return {
    agents,
    enabled,
    enabledIds,
    multiple,
    preferred,
    isEnabled,
    save,
    refresh,
    /** Resolves once the backend has answered (or failed to). */
    ready,
  };
}

const Ctx = createContext<ReturnType<typeof makeAgentsContext>>();

export function AgentsProvider(props: ParentProps) {
  const ctx = makeAgentsContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useAgents() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAgents outside AgentsProvider");
  return v;
}
