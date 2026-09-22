import {
  createContext,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentId } from "@/lib/agents";
import { removeProjectTabs } from "@/lib/close-tabs";

/** `dormant` is a tab restored from the remembered workspace that has never
 *  been given a PTY. It exists in the strip with its label so reopening a
 *  project brings the whole workspace back, but the agent is only resumed
 *  when the user activates it (see `wakeTab`) — restoring N sessions must
 *  not mean spawning N processes on window open (decision #9). */
export type TabStatus = "dormant" | "opening" | "running" | "exited" | "error";

export type TerminalTab = {
  id: string;
  projectPath: string;
  sessionId: string | null;
  /** Which agent this tab runs. Resolved by the caller *before* the tab is
   *  created — never assigned afterwards, for the same reason as
   *  `profileId`: a tab that exists for even one tick without knowing its
   *  agent is a tab a live session event can be misrouted to. */
  agentId: AgentId;
  /** "default" or "custom:<...>" (see project_env::profile_id_for_config_dir),
   *  resolved *before* this tab is created (never assigned after the fact —
   *  that would leave a window where a live session event can't tell which
   *  profile the tab belongs to). Every consumer of session:new/meta/complete
   *  must gate on this being exactly "default", since the backend watcher
   *  that emits those only observes the default ~/.claude/projects root. */
  profileId: string;
  label: string;
  status: TabStatus;
  exitCode: number | null;
  error: string | null;
  /** epoch ms when the PTY was requested; used by the session watcher to
   *  correlate "new" tabs with their JSONL once Claude writes one. */
  spawnedAt: number;
  /** True when this tab fired a notification while the user was looking
   *  elsewhere. Drives the amber pulse in the tab strip. Cleared by
   *  user-action tab activation (tab-strip click, sidebar/palette select)
   *  or by xterm onData (the user is typing here). Project-switch does
   *  NOT clear — see PRP 018 §4. */
  needsAttention: boolean;
};

type TerminalStore = {
  tabs: TerminalTab[];
  activeTabId: string | null;
};

type DataHandler = (bytes: Uint8Array) => void;
type ExitHandler = (code: number) => void;

export type OpenTabOpts = {
  label: string;
  /** The session to resume, or null for a fresh one. This is also what
   *  decides the argv: the backend asks its registry for the agent's resume
   *  flags rather than taking them from here, so a caller cannot build an
   *  argv that disagrees with the session the tab was created with.
   *
   *  A fresh tab of an agent that can be handed its id up front (Cursor)
   *  gets one minted here, after the tab is on screen — see `openTab`. */
  sessionId: string | null;
  agentId: AgentId;
  /** Resolved by the caller via `resolve_profile_id` *before* calling
   *  `openTab` — see `TerminalTab.profileId`. */
  profileId: string;
};

/** Minting a session id failed, so the tab that was waiting for it has been
 *  taken back out of the strip. Distinct from a spawn failure, which leaves
 *  an error tab behind: here nothing was ever started. */
export class SessionMintError extends Error {
  constructor(readonly cause: unknown) {
    super(String(cause));
    this.name = "SessionMintError";
  }
}

function newId(): string {
  // crypto.randomUUID is available in modern WebKit/Chromium.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function makeTerminalContext() {
  const [store, setStore] = createStore<TerminalStore>({
    tabs: [],
    activeTabId: null,
  });

  const unlistens = new Map<string, { data: UnlistenFn; exit: UnlistenFn }>();
  const dataHandlers = new Map<string, Set<DataHandler>>();
  const exitHandlers = new Map<string, Set<ExitHandler>>();

  async function attachListeners(id: string) {
    const dUn = await listen<string>(`pty:data:${id}`, (e) => {
      const bytes = base64ToBytes(e.payload);
      const set = dataHandlers.get(id);
      if (set) for (const h of set) h(bytes);
    });
    const xUn = await listen<number>(`pty:exit:${id}`, (e) => {
      setStore(
        "tabs",
        (t) => t.id === id,
        produce((tab: TerminalTab) => {
          tab.status = "exited";
          tab.exitCode = e.payload;
        }),
      );
      const set = exitHandlers.get(id);
      if (set) for (const h of set) h(e.payload);
    });
    unlistens.set(id, { data: dUn, exit: xUn });
  }

  async function detachListeners(id: string) {
    const un = unlistens.get(id);
    if (un) {
      un.data();
      un.exit();
      unlistens.delete(id);
    }
    dataHandlers.delete(id);
    exitHandlers.delete(id);
  }

  /** Gives a PTY to a tab that is already in the store. Shared by `openTab`
   *  (fresh tab) and `wakeTab` (restored dormant tab) so both paths agree on
   *  listener ordering and on what an `pty_open` failure leaves behind. */
  async function spawn(
    id: string,
    projectPath: string,
    agentId: AgentId,
    sessionId: string | null,
    profileId: string,
  ): Promise<void> {
    // CRITICAL: subscribe BEFORE invoking pty_open. Otherwise Rust starts
    // emitting pty:data:<id> immediately and initial bytes (Claude's welcome,
    // ANSI init, prompt line) are lost — resulting in a blank terminal.
    await attachListeners(id);

    setStore(
      "tabs",
      (t) => t.id === id,
      produce((tab: TerminalTab) => {
        tab.status = "opening";
        tab.exitCode = null;
        tab.error = null;
        tab.spawnedAt = Date.now();
      }),
    );

    try {
      await invoke("pty_open", {
        id,
        projectPath,
        agentId,
        sessionId,
        expectedProfileId: profileId,
      });
    } catch (err) {
      const msg = String(err);
      console.error("pty_open failed", msg);
      await detachListeners(id);
      setStore(
        produce((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx >= 0) {
            s.tabs[idx].status = "error";
            s.tabs[idx].error = msg;
          }
        }),
      );
      throw err;
    }

    setStore(
      "tabs",
      (t) => t.id === id,
      produce((tab: TerminalTab) => {
        tab.status = "running";
      }),
    );
  }

  async function openTab(
    projectPath: string,
    opts: OpenTabOpts,
  ): Promise<string> {
    const id = newId();
    const tab: TerminalTab = {
      id,
      projectPath,
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      profileId: opts.profileId,
      label: opts.label,
      status: "opening",
      exitCode: null,
      error: null,
      spawnedAt: Date.now(),
      needsAttention: false,
    };
    setStore(
      produce((s) => {
        s.tabs.push(tab);
        s.activeTabId = id;
      }),
    );

    // The tab is on screen, loader and all, *before* anything slow happens.
    // For Cursor the slow thing is `create-chat`, a round trip to Cursor's
    // backend (~2 s measured); minting it before the tab existed left `+`
    // and ⌘T looking dead for that long.
    let sessionId = opts.sessionId;
    if (sessionId === null) {
      try {
        sessionId = await invoke<string | null>("agent_create_session", {
          projectPath,
          agentId: opts.agentId,
        });
      } catch (err) {
        removeTab(id);
        throw new SessionMintError(err);
      }
      // Assigned while the tab is still "opening" and before its PTY exists,
      // so nothing can have observed it without an id it should have had —
      // the same reason `agentId` and `profileId` are never set later.
      if (sessionId !== null) {
        setStore("tabs", (t) => t.id === id, "sessionId", sessionId);
      }
    }

    await spawn(id, projectPath, opts.agentId, sessionId, opts.profileId);
    return id;
  }

  /** Takes a tab that never got a PTY back out of the strip, handing focus
   *  back to whichever tab had it before. */
  function removeTab(id: string): void {
    setStore(
      produce((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        const projectPath = s.tabs[idx].projectPath;
        s.tabs.splice(idx, 1);
        if (s.activeTabId === id) {
          const sibling = [...s.tabs].reverse().find((t) => t.projectPath === projectPath);
          s.activeTabId = sibling?.id ?? null;
        }
      }),
    );
  }

  /** Rebuilds a remembered workspace: pushes one dormant tab per entry, in
   *  order, without spawning anything. Synchronous on purpose — the strip
   *  must settle in its stored order before the caller wakes one of them,
   *  otherwise the woken tab would race ahead of its siblings. Does not
   *  touch `activeTabId`; the caller decides which tab to activate. */
  function restoreTabs(
    projectPath: string,
    agentId: AgentId,
    profileId: string,
    entries: { sessionId: string; label: string }[],
  ): string[] {
    const ids: string[] = [];
    setStore(
      produce((s) => {
        for (const e of entries) {
          const id = newId();
          ids.push(id);
          s.tabs.push({
            id,
            projectPath,
            sessionId: e.sessionId,
            agentId,
            profileId,
            label: e.label,
            status: "dormant",
            exitCode: null,
            error: null,
            spawnedAt: 0,
            needsAttention: false,
          });
        }
      }),
    );
    return ids;
  }

  /** Resumes a dormant tab's session, in place — it keeps its position in
   *  the strip and its tab id. The argv comes from the tab's agent, in the
   *  backend registry. A no-op on any other status, so activation paths can
   *  call it unconditionally. */
  async function wakeTab(id: string): Promise<void> {
    const tab = store.tabs.find((t) => t.id === id);
    if (!tab || tab.status !== "dormant" || !tab.sessionId) return;
    // Leave `dormant` synchronously, before the first await: the restore path
    // wakes its tab explicitly *and* activating it trips the auto-wake effect
    // in App.tsx. Without this both would still see `dormant` and spawn a
    // second PTY for the same tab. `spawn` sets the status again itself.
    setStore("tabs", (t) => t.id === id, "status", "opening");
    await spawn(id, tab.projectPath, tab.agentId, tab.sessionId, tab.profileId);
  }

  async function closeTab(id: string): Promise<void> {
    // A dormant tab never spawned, so there is nothing on the Rust side to
    // kill — invoking would just log an unknown-id warning per closed tab.
    if (store.tabs.find((t) => t.id === id)?.status !== "dormant") {
      try {
        await invoke("pty_kill", { id });
      } catch (err) {
        console.warn("pty_kill failed", err);
      }
    }
    await detachListeners(id);
    setStore(
      produce((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        const closed = s.tabs[idx];
        s.tabs.splice(idx, 1);
        if (s.activeTabId === id) {
          // Pick the nearest sibling in the SAME project (prefer left, then
          // right). Falling back to the global tab list lands on a foreign
          // project's tab, leaving the active project's pane blank — see #20.
          const siblings: { tab: TerminalTab; pos: number }[] = [];
          s.tabs.forEach((t, i) => {
            if (t.projectPath === closed.projectPath) {
              siblings.push({ tab: t, pos: i });
            }
          });
          if (siblings.length === 0) {
            s.activeTabId = null;
          } else {
            const prev = [...siblings].reverse().find((x) => x.pos < idx);
            const next = siblings.find((x) => x.pos >= idx);
            s.activeTabId = (prev ?? next ?? siblings[0]).tab.id;
          }
        }
      }),
    );
  }

  /** Tears down every tab of one project. The teardown is invisible to
   *  anything watching the store: listeners come off first so a dying PTY's
   *  exit event can't land mid-teardown, and the tabs then leave in a single
   *  transition. Removing them one at a time is what truncated remembered
   *  workspaces to their last-closed tab (#105) — see `removeProjectTabs`. */
  async function closeTabsForProject(projectPath: string): Promise<void> {
    const doomed = store.tabs.filter((t) => t.projectPath === projectPath);
    if (doomed.length === 0) return;
    for (const tab of doomed) {
      // eslint-disable-next-line no-await-in-loop
      await detachListeners(tab.id);
      // A dormant tab never spawned, so there is nothing on the Rust side to
      // kill — invoking would just log an unknown-id warning per closed tab.
      if (tab.status === "dormant") continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await invoke("pty_kill", { id: tab.id });
      } catch (err) {
        console.warn("pty_kill failed", err);
      }
    }
    setStore(
      produce((s) => {
        const next = removeProjectTabs(s.tabs, s.activeTabId, projectPath);
        s.tabs = next.tabs;
        s.activeTabId = next.activeTabId;
      }),
    );
  }

  /** Same contract as `closeTabsForProject`, for every project at once. Runs
   *  on provider teardown, where a per-tab walk would truncate *every*
   *  remembered workspace on the way down (#105). */
  async function closeAll(): Promise<void> {
    const all = [...store.tabs];
    if (all.length === 0) return;
    for (const tab of all) {
      // eslint-disable-next-line no-await-in-loop
      await detachListeners(tab.id);
      if (tab.status === "dormant") continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await invoke("pty_kill", { id: tab.id });
      } catch (err) {
        console.warn("pty_kill failed", err);
      }
    }
    setStore(
      produce((s) => {
        s.tabs = [];
        s.activeTabId = null;
      }),
    );
  }

  function setActiveTab(id: string | null) {
    if (id !== null && !store.tabs.find((t) => t.id === id)) return;
    setStore("activeTabId", id);
  }

  async function write(id: string, bytes: Uint8Array) {
    const b64 = bytesToBase64(bytes);
    try {
      await invoke("pty_write", { id, b64 });
    } catch (err) {
      console.error("pty_write failed", err);
    }
  }

  async function resize(id: string, cols: number, rows: number) {
    try {
      await invoke("pty_resize", { id, cols, rows });
    } catch (err) {
      console.error("pty_resize failed", err);
    }
  }

  function onData(id: string, h: DataHandler) {
    let set = dataHandlers.get(id);
    if (!set) {
      set = new Set();
      dataHandlers.set(id, set);
    }
    set.add(h);
    return () => {
      const s = dataHandlers.get(id);
      s?.delete(h);
    };
  }

  function onExit(id: string, h: ExitHandler) {
    let set = exitHandlers.get(id);
    if (!set) {
      set = new Set();
      exitHandlers.set(id, set);
    }
    set.add(h);
    return () => {
      const s = exitHandlers.get(id);
      s?.delete(h);
    };
  }

  function getTab(id: string): TerminalTab | undefined {
    return store.tabs.find((t) => t.id === id);
  }

  function findTabBySessionId(sessionId: string): TerminalTab | undefined {
    return store.tabs.find((t) => t.sessionId === sessionId);
  }

  /** Attach a discovered sessionId to a "new" tab. Caller is responsible for
   *  FIFO selection of which pending tab to promote. */
  function promoteTab(id: string, sessionId: string, preview: string | null) {
    setStore(
      "tabs",
      (t) => t.id === id,
      produce((tab: TerminalTab) => {
        tab.sessionId = sessionId;
        if (preview && tab.label === "New session") {
          tab.label = preview;
        }
      }),
    );
  }

  function setTabLabel(id: string, label: string) {
    setStore(
      "tabs",
      (t) => t.id === id,
      produce((tab: TerminalTab) => {
        tab.label = label;
      }),
    );
  }

  // Early-return is load-bearing: clearTabAttention runs on every xterm
  // keystroke via terminal-view.tsx's onData hook. Without the guard
  // Solid's reactive graph dirties on every char, dragging dependent
  // memos (tab-strip dot class, etc.) with it.
  function markTabNeedsAttention(id: string) {
    const tab = store.tabs.find((t) => t.id === id);
    if (!tab || tab.needsAttention) return;
    setStore("tabs", (t) => t.id === id, "needsAttention", true);
  }

  function clearTabAttention(id: string) {
    const tab = store.tabs.find((t) => t.id === id);
    if (!tab || !tab.needsAttention) return;
    setStore("tabs", (t) => t.id === id, "needsAttention", false);
  }

  onCleanup(() => {
    void closeAll();
  });

  return {
    store,
    openTab,
    restoreTabs,
    wakeTab,
    closeTab,
    closeTabsForProject,
    closeAll,
    setActiveTab,
    write,
    resize,
    onData,
    onExit,
    getTab,
    findTabBySessionId,
    promoteTab,
    setTabLabel,
    markTabNeedsAttention,
    clearTabAttention,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const Ctx = createContext<ReturnType<typeof makeTerminalContext>>();

export function TerminalProvider(props: ParentProps) {
  const ctx = makeTerminalContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useTerminal() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTerminal outside TerminalProvider");
  return v;
}
