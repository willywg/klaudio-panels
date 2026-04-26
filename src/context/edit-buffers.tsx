import {
  createContext,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore } from "solid-js/store";

/** A single open inline-editor buffer. `baseline` is what's on disk after
 *  the last successful read or write — comparing the live CodeMirror doc
 *  against it produces the dirty flag. `baselineMtime` lets us reject
 *  stale-write attempts and decide whether an external `fs-event` is news. */
export type EditBuffer = {
  baseline: string;
  baselineMtime: number;
  saving: boolean;
  dirty: boolean;
};

function bufferKey(projectPath: string, rel: string): string {
  return `${projectPath}::${rel}`;
}

function makeEditBuffersContext() {
  const [store, setStore] = createStore<Record<string, EditBuffer>>({});

  function register(
    projectPath: string,
    rel: string,
    baseline: string,
    baselineMtime: number,
  ) {
    setStore(bufferKey(projectPath, rel), {
      baseline,
      baselineMtime,
      saving: false,
      dirty: false,
    });
  }

  function unregister(projectPath: string, rel: string) {
    setStore(bufferKey(projectPath, rel), undefined!);
  }

  function markDirty(projectPath: string, rel: string, isDirty: boolean) {
    const key = bufferKey(projectPath, rel);
    if (!store[key]) return;
    setStore(key, "dirty", isDirty);
  }

  function setSaving(projectPath: string, rel: string, value: boolean) {
    const key = bufferKey(projectPath, rel);
    if (!store[key]) return;
    setStore(key, "saving", value);
  }

  function updateBaseline(
    projectPath: string,
    rel: string,
    baseline: string,
    baselineMtime: number,
  ) {
    const key = bufferKey(projectPath, rel);
    if (!store[key]) return;
    setStore(key, {
      baseline,
      baselineMtime,
      dirty: false,
    });
  }

  function get(projectPath: string, rel: string): EditBuffer | undefined {
    return store[bufferKey(projectPath, rel)];
  }

  function dirty(projectPath: string, rel: string): boolean {
    return store[bufferKey(projectPath, rel)]?.dirty ?? false;
  }

  return {
    register,
    unregister,
    markDirty,
    setSaving,
    updateBaseline,
    get,
    dirty,
  };
}

const Ctx = createContext<ReturnType<typeof makeEditBuffersContext>>();

export function EditBuffersProvider(props: ParentProps) {
  const ctx = makeEditBuffersContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useEditBuffers() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEditBuffers outside EditBuffersProvider");
  return v;
}
