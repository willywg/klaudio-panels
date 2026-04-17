import {
  createContext,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Status = "idle" | "running" | "exited" | "error";

type Store = {
  id: string | null;
  status: Status;
  exitCode: number | null;
  error: string | null;
};

type DataHandler = (bytes: Uint8Array) => void;
type ExitHandler = (code: number) => void;

export function makeTerminalContext() {
  const [store, setStore] = createStore<Store>({
    id: null,
    status: "idle",
    exitCode: null,
    error: null,
  });

  const dataHandlers = new Set<DataHandler>();
  const exitHandlers = new Set<ExitHandler>();
  let unlistenData: UnlistenFn | undefined;
  let unlistenExit: UnlistenFn | undefined;

  async function attachListeners(id: string) {
    await detachListeners();
    unlistenData = await listen<string>(`pty:data:${id}`, (e) => {
      const bytes = base64ToBytes(e.payload);
      for (const h of dataHandlers) h(bytes);
    });
    unlistenExit = await listen<number>(`pty:exit:${id}`, (e) => {
      setStore({ status: "exited", exitCode: e.payload });
      for (const h of exitHandlers) h(e.payload);
    });
  }

  async function detachListeners() {
    unlistenData?.();
    unlistenExit?.();
    unlistenData = undefined;
    unlistenExit = undefined;
  }

  async function open(projectPath: string, args: string[] = []): Promise<string> {
    await kill();
    setStore({ status: "running", exitCode: null, error: null });
    try {
      const id = (await invoke("pty_open", { projectPath, args })) as string;
      setStore("id", id);
      await attachListeners(id);
      return id;
    } catch (err) {
      setStore({ status: "error", error: String(err) });
      throw err;
    }
  }

  async function write(bytes: Uint8Array) {
    const id = store.id;
    if (!id) return;
    const b64 = bytesToBase64(bytes);
    try {
      await invoke("pty_write", { id, b64 });
    } catch (err) {
      console.error("pty_write failed", err);
    }
  }

  async function resize(cols: number, rows: number) {
    const id = store.id;
    if (!id) return;
    try {
      await invoke("pty_resize", { id, cols, rows });
    } catch (err) {
      console.error("pty_resize failed", err);
    }
  }

  async function kill() {
    const id = store.id;
    if (!id) return;
    try {
      await invoke("pty_kill", { id });
    } catch (err) {
      console.error("pty_kill failed", err);
    } finally {
      await detachListeners();
      setStore({ id: null, status: "idle", exitCode: null });
    }
  }

  function onData(h: DataHandler) {
    dataHandlers.add(h);
    return () => dataHandlers.delete(h);
  }

  function onExit(h: ExitHandler) {
    exitHandlers.add(h);
    return () => exitHandlers.delete(h);
  }

  onCleanup(() => {
    void detachListeners();
    void kill();
  });

  return { store, open, write, resize, kill, onData, onExit };
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
