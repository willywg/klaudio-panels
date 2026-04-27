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
  id: string;
  projectPath: string;
  sessionId: string | null;
  label: string;
  status: TabStatus;
  exitCode: number | null;
  error: string | null;
  /** epoch ms when the PTY was requested; used by the session watcher to
   *  correlate "new" tabs with their JSONL once Claude writes one. */
  spawnedAt: number;
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

  async function openTab(
    projectPath: string,
    args: string[],
    opts: OpenTabOpts,
  ): Promise<string> {
    const id = newId();
    // CRITICAL: subscribe BEFORE invoking pty_open. Otherwise Rust starts
    // emitting pty:data:<id> immediately and initial bytes (Claude's welcome,
    // ANSI init, prompt line) are lost — resulting in a blank terminal.
    await attachListeners(id);

    const tab: TerminalTab = {
      id,
      projectPath,
      sessionId: opts.sessionId,
      label: opts.label,
      status: "opening",
      exitCode: null,
      error: null,
      spawnedAt: Date.now(),
    };
    setStore(
      produce((s) => {
        s.tabs.push(tab);
        s.activeTabId = id;
      }),
    );

    try {
      await invoke("pty_open", { id, projectPath, args });
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

    return id;
  }

  async function closeTab(id: string): Promise<void> {
    try {
      await invoke("pty_kill", { id });
    } catch (err) {
      console.warn("pty_kill failed", err);
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
    promoteTab,
    setTabLabel,
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
