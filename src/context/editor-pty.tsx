import {
  createContext,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { findTerminalEditor } from "@/lib/terminal-editors";

export type EditorPtyStatus = "opening" | "running" | "exited" | "error";

export type EditorPtyTab = {
  ptyId: string;
  projectPath: string;
  /** Terminal-editor id from TERMINAL_EDITORS (nvim, vim, helix, micro). */
  editorId: string;
  /** Absolute path of the file being edited. */
  absPath: string;
  /** Project-relative path (used to label the tab). */
  relPath: string;
  status: EditorPtyStatus;
  exitCode: number | null;
  error: string | null;
};

type Store = {
  tabs: EditorPtyTab[];
};

type DataHandler = (bytes: Uint8Array) => void;
type ExitHandler = (code: number) => void;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "ed-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function makeEditorPtyContext() {
  const [store, setStore] = createStore<Store>({ tabs: [] });

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
        produce((tab: EditorPtyTab) => {
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

  /** Reserve an editor PTY slot. Returns a ptyId synchronously so the
   *  caller can push a panel tab and mount the xterm view immediately.
   *  The view then calls `spawnPty(ptyId, cols, rows)` once it has a
   *  measured terminal size — this avoids nvim/helix spawning at the
   *  default 80x24 and then having to reflow on the first SIGWINCH
   *  (which some TUIs drop while they're in an initial modal prompt). */
  function openEditor(
    projectPath: string,
    absPath: string,
    relPath: string,
    editorId: string,
  ): string {
    const editor = findTerminalEditor(editorId);
    if (!editor) throw new Error(`unknown terminal editor: ${editorId}`);

    const ptyId = newId();
    const tab: EditorPtyTab = {
      ptyId,
      projectPath,
      editorId,
      absPath,
      relPath,
      status: "opening",
      exitCode: null,
      error: null,
    };
    setStore(
      produce((s) => {
        s.tabs.push(tab);
      }),
    );
    return ptyId;
  }

  /** Kick off the actual PTY spawn with the measured cols/rows. Safe to
   *  call exactly once per ptyId — subsequent calls are no-ops. */
  async function spawnPty(ptyId: string, cols: number, rows: number): Promise<void> {
    const tab = store.tabs.find((t) => t.ptyId === ptyId);
    if (!tab) return;
    const editor = findTerminalEditor(tab.editorId);
    if (!editor) return;
    try {
      await attachListeners(ptyId);
      await invoke("pty_open_editor", {
        id: ptyId,
        projectPath: tab.projectPath,
        binary: editor.binary,
        args: [...editor.args, tab.absPath],
        cols,
        rows,
      });
      setStore(
        "tabs",
        (t) => t.ptyId === ptyId,
        produce((t: EditorPtyTab) => {
          t.status = "running";
        }),
      );
    } catch (err) {
      const msg = String(err);
      console.error("pty_open_editor failed", msg);
      detachListeners(ptyId);
      setStore(
        "tabs",
        (t) => t.ptyId === ptyId,
        produce((t: EditorPtyTab) => {
          t.status = "error";
          t.error = msg;
        }),
      );
    }
  }

  async function killEditor(ptyId: string): Promise<void> {
    try {
      await invoke("pty_kill", { id: ptyId });
    } catch (err) {
      console.warn("pty_kill (editor) failed", err);
    }
    detachListeners(ptyId);
    setStore(
      produce((s) => {
        const idx = s.tabs.findIndex((t) => t.ptyId === ptyId);
        if (idx >= 0) s.tabs.splice(idx, 1);
      }),
    );
  }

  async function write(ptyId: string, bytes: Uint8Array) {
    const b64 = bytesToBase64(bytes);
    try {
      await invoke("pty_write", { id: ptyId, b64 });
    } catch (err) {
      console.error("pty_write (editor) failed", err);
    }
  }

  async function resize(ptyId: string, cols: number, rows: number) {
    try {
      await invoke("pty_resize", { id: ptyId, cols, rows });
    } catch (err) {
      console.error("pty_resize (editor) failed", err);
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

  function getTab(ptyId: string): EditorPtyTab | undefined {
    return store.tabs.find((t) => t.ptyId === ptyId);
  }

  /** Fire-and-forget cleanup. Used on project close — each PTY kill is
   *  independent and we don't need to wait on them serially. */
  function killAllForProject(projectPath: string) {
    const ids = store.tabs
      .filter((t) => t.projectPath === projectPath)
      .map((t) => t.ptyId);
    for (const id of ids) void killEditor(id);
  }

  onCleanup(() => {
    const ids = store.tabs.map((t) => t.ptyId);
    for (const id of ids) void killEditor(id);
  });

  return {
    store,
    openEditor,
    spawnPty,
    killEditor,
    killAllForProject,
    write,
    resize,
    onData,
    onExit,
    getTab,
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

const Ctx = createContext<ReturnType<typeof makeEditorPtyContext>>();

export function EditorPtyProvider(props: ParentProps) {
  const ctx = makeEditorPtyContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useEditorPty() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEditorPty outside EditorPtyProvider");
  return v;
}
