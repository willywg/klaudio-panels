import {
  createContext,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ShellPtyStatus = "opening" | "running" | "exited" | "error";

export type ShellPtyTab = {
  ptyId: string;
  projectPath: string;
  /** 1-based, stable within the project — surviving the index of closed
   *  siblings so "shell 3" stays "shell 3" after closing "shell 2". */
  index: number;
  status: ShellPtyStatus;
  exitCode: number | null;
  error: string | null;
};

type Store = {
  tabs: ShellPtyTab[];
  /** projectPath -> active ptyId. Separate from the flat tab list so
   *  switching project doesn't require walking every tab. */
  activeByProject: Record<string, string | null>;
};

type DataHandler = (bytes: Uint8Array) => void;
type ExitHandler = (code: number) => void;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "sh-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function makeShellPtyContext() {
  const [store, setStore] = createStore<Store>({
    tabs: [],
    activeByProject: {},
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
        (t) => t.ptyId === id,
        produce((tab: ShellPtyTab) => {
          tab.status = "exited";
          tab.exitCode = e.payload;
        }),
      );
      const set = exitHandlers.get(id);
      if (set) for (const h of set) h(e.payload);
    });
    unlistens.set(id, { data: dUn, exit: xUn });
  }

  function detachListeners(id: string) {
    const un = unlistens.get(id);
    if (un) {
      un.data();
      un.exit();
      unlistens.delete(id);
    }
    dataHandlers.delete(id);
    exitHandlers.delete(id);
  }

  function nextIndexFor(projectPath: string): number {
    let max = 0;
    for (const t of store.tabs) {
      if (t.projectPath === projectPath && t.index > max) max = t.index;
    }
    return max + 1;
  }

  async function openTab(projectPath: string): Promise<string> {
    const ptyId = newId();
    const index = nextIndexFor(projectPath);

    // CRITICAL: subscribe BEFORE invoking the backend. Otherwise the shell's
    // greeting / first prompt is emitted before the listener attaches and the
    // terminal renders blank. Same race we fixed for the Claude PTY.
    await attachListeners(ptyId);

    const tab: ShellPtyTab = {
      ptyId,
      projectPath,
      index,
      status: "opening",
      exitCode: null,
      error: null,
    };
    setStore(
      produce((s) => {
        s.tabs.push(tab);
        s.activeByProject[projectPath] = ptyId;
      }),
    );

    try {
      await invoke("pty_open_shell", { id: ptyId, projectPath });
      setStore(
        "tabs",
        (t) => t.ptyId === ptyId,
        produce((t: ShellPtyTab) => {
          t.status = "running";
        }),
      );
    } catch (err) {
      const msg = String(err);
      console.error("pty_open_shell failed", msg);
      detachListeners(ptyId);
      setStore(
        "tabs",
        (t) => t.ptyId === ptyId,
        produce((t: ShellPtyTab) => {
          t.status = "error";
          t.error = msg;
        }),
      );
    }

    return ptyId;
  }

  async function closeTab(ptyId: string): Promise<void> {
    const tab = store.tabs.find((t) => t.ptyId === ptyId);
    try {
      await invoke("pty_kill", { id: ptyId });
    } catch (err) {
      console.warn("pty_kill (shell) failed", err);
    }
    detachListeners(ptyId);
    setStore(
      produce((s) => {
        const idx = s.tabs.findIndex((t) => t.ptyId === ptyId);
        if (idx < 0) return;
        s.tabs.splice(idx, 1);
        if (tab && s.activeByProject[tab.projectPath] === ptyId) {
          const remaining = s.tabs.filter(
            (t) => t.projectPath === tab.projectPath,
          );
          s.activeByProject[tab.projectPath] =
            remaining.length > 0 ? remaining[remaining.length - 1].ptyId : null;
        }
      }),
    );
  }

  function setActiveForProject(projectPath: string, ptyId: string | null) {
    if (ptyId && !store.tabs.some((t) => t.ptyId === ptyId)) return;
    setStore("activeByProject", projectPath, ptyId);
  }

  function tabsForProject(projectPath: string): ShellPtyTab[] {
    return store.tabs.filter((t) => t.projectPath === projectPath);
  }

  function activeForProject(projectPath: string): string | null {
    return store.activeByProject[projectPath] ?? null;
  }

  async function write(ptyId: string, bytes: Uint8Array) {
    const b64 = bytesToBase64(bytes);
    try {
      await invoke("pty_write", { id: ptyId, b64 });
    } catch (err) {
      console.error("pty_write (shell) failed", err);
    }
  }

  async function resize(ptyId: string, cols: number, rows: number) {
    try {
      await invoke("pty_resize", { id: ptyId, cols, rows });
    } catch (err) {
      console.error("pty_resize (shell) failed", err);
    }
  }

  function onData(ptyId: string, h: DataHandler) {
    let set = dataHandlers.get(ptyId);
    if (!set) {
      set = new Set();
      dataHandlers.set(ptyId, set);
    }
    set.add(h);
    return () => {
      const s = dataHandlers.get(ptyId);
      s?.delete(h);
    };
  }

  function onExit(ptyId: string, h: ExitHandler) {
    let set = exitHandlers.get(ptyId);
    if (!set) {
      set = new Set();
      exitHandlers.set(ptyId, set);
    }
    set.add(h);
    return () => {
      const s = exitHandlers.get(ptyId);
      s?.delete(h);
    };
  }

  function getTab(ptyId: string): ShellPtyTab | undefined {
    return store.tabs.find((t) => t.ptyId === ptyId);
  }

  /** Fire-and-forget — each kill is independent and the caller doesn't
   *  need to wait serially. Mirrors editor-pty.killAllForProject. */
  function killAllForProject(projectPath: string) {
    const ids = store.tabs
      .filter((t) => t.projectPath === projectPath)
      .map((t) => t.ptyId);
    for (const id of ids) void closeTab(id);
  }

  onCleanup(() => {
    const ids = store.tabs.map((t) => t.ptyId);
    for (const id of ids) void closeTab(id);
  });

  return {
    store,
    openTab,
    closeTab,
    setActiveForProject,
    tabsForProject,
    activeForProject,
    write,
    resize,
    onData,
    onExit,
    getTab,
    killAllForProject,
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

const Ctx = createContext<ReturnType<typeof makeShellPtyContext>>();

export function ShellPtyProvider(props: ParentProps) {
  const ctx = makeShellPtyContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useShellPty() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShellPty outside ShellPtyProvider");
  return v;
}
