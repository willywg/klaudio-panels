import {
  createContext,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TabStatus = "opening" | "running" | "exited" | "error";

export type TerminalTab = {
  /** Stable identity of the tab. Starts as a temp id ("pending:...") while
   *  `pty_open` is in-flight, then swapped to the PTY UUID on success. */
  id: string;
  projectPath: string;
  sessionId: string | null;
  label: string;
  status: TabStatus;
  exitCode: number | null;
  error: string | null;
};

type TerminalStore = {
  tabs: TerminalTab[];
  activeTabId: string | null;
};

type DataHandler = (bytes: Uint8Array) => void;
type ExitHandler = (code: number) => void;

export type OpenTabOpts = {
  label: string;
  sessionId: string | null;
};

let tempCounter = 0;
function nextTempId(): string {
  tempCounter += 1;
  return `pending:${Date.now().toString(36)}-${tempCounter}`;
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

  async function openTab(
    projectPath: string,
    args: string[],
    opts: OpenTabOpts,
  ): Promise<string> {
    // Step 1 — create a pending tab immediately. This is what dedupes rapid
    // clicks: the next `tabs.find(sessionId)` check sees the pending tab.
    const tempId = nextTempId();
    const pending: TerminalTab = {
      id: tempId,
      projectPath,
      sessionId: opts.sessionId,
      label: opts.label,
      status: "opening",
      exitCode: null,
      error: null,
    };
    setStore(
      produce((s) => {
        s.tabs.push(pending);
        s.activeTabId = tempId;
      }),
    );

    // Step 2 — actually spawn.
    let realId: string;
    try {
      realId = (await invoke("pty_open", { projectPath, args })) as string;
    } catch (err) {
      const msg = String(err);
      console.error("pty_open failed", msg);
      setStore(
        produce((s) => {
          const idx = s.tabs.findIndex((t) => t.id === tempId);
          if (idx >= 0) {
            s.tabs[idx].status = "error";
            s.tabs[idx].error = msg;
          }
        }),
      );
      throw err;
    }

    // Step 3 — swap tempId → realId atomically, keeping active-ness.
    setStore(
      produce((s) => {
        const idx = s.tabs.findIndex((t) => t.id === tempId);
        if (idx >= 0) {
          s.tabs[idx].id = realId;
          s.tabs[idx].status = "running";
        }
        if (s.activeTabId === tempId) s.activeTabId = realId;
      }),
    );

    await attachListeners(realId);
    return realId;
  }

  async function closeTab(id: string): Promise<void> {
    // Pending tabs may not have a backing PTY yet — skip the kill invoke.
    const isPending = id.startsWith("pending:");
    if (!isPending) {
      try {
        await invoke("pty_kill", { id });
      } catch (err) {
        console.warn("pty_kill failed", err);
      }
      const un = unlistens.get(id);
      if (un) {
        un.data();
        un.exit();
        unlistens.delete(id);
      }
      dataHandlers.delete(id);
      exitHandlers.delete(id);
    }
    setStore(
      produce((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        s.tabs.splice(idx, 1);
        if (s.activeTabId === id) {
          if (s.tabs.length === 0) {
            s.activeTabId = null;
          } else {
            const next = Math.max(0, idx - 1);
            s.activeTabId = s.tabs[Math.min(next, s.tabs.length - 1)].id;
          }
        }
      }),
    );
  }

  async function closeAll(): Promise<void> {
    const ids = store.tabs.map((t) => t.id);
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await closeTab(id);
    }
  }

  function setActiveTab(id: string | null) {
    if (id !== null && !store.tabs.find((t) => t.id === id)) return;
    setStore("activeTabId", id);
  }

  async function write(id: string, bytes: Uint8Array) {
    if (id.startsWith("pending:")) return;
    const b64 = bytesToBase64(bytes);
    try {
      await invoke("pty_write", { id, b64 });
    } catch (err) {
      console.error("pty_write failed", err);
    }
  }

  async function resize(id: string, cols: number, rows: number) {
    if (id.startsWith("pending:")) return;
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

  /** Returns the tab currently opening a given sessionId (pending or running),
   *  or undefined. Used by handleSelect to dedupe rapid clicks. */
  function findTabBySessionId(sessionId: string): TerminalTab | undefined {
    return store.tabs.find((t) => t.sessionId === sessionId);
  }

  onCleanup(() => {
    void closeAll();
  });

  return {
    store,
    openTab,
    closeTab,
    closeAll,
    setActiveTab,
    write,
    resize,
    onData,
    onExit,
    getTab,
    findTabBySessionId,
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
