import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type ParentProps,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  getClipboardEnabled,
  setClipboardEnabled,
} from "@/lib/clipboard-prefs";

/** Mirrors `ClipEntry` in `src-tauri/src/clipboard_history.rs`. */
export type ClipEntry = {
  id: number;
  text: string;
  copied_at_ms: number;
  truncated: boolean;
};

const MAX_ENTRIES = 10;

/** Apply a newly-observed clip to the current list: newest first, re-copying
 *  something already held promotes it rather than duplicating the row. Mirrors
 *  `insert_entry` on the Rust side, which owns the authoritative ring — this
 *  keeps the UI in step between `clipboard:new` events without a round trip.
 *
 *  Exported for tests. */
export function applyClip(
  list: readonly ClipEntry[],
  entry: ClipEntry,
): ClipEntry[] {
  const without = list.filter((e) => e.text !== entry.text);
  return [entry, ...without].slice(0, MAX_ENTRIES);
}

function makeClipboardHistoryContext() {
  const [entries, setEntries] = createSignal<readonly ClipEntry[]>([]);
  const [enabled, setEnabledSignal] = createSignal(getClipboardEnabled());

  onMount(() => {
    // Push the persisted choice down before anything can be recorded — the
    // backend defaults to on, and a user who turned it off last session must
    // not have this session's first copy captured.
    void invoke("clipboard_history_set_enabled", {
      enabled: getClipboardEnabled(),
    }).catch((err) => console.warn("clipboard_history_set_enabled failed", err));

    void invoke<ClipEntry[]>("clipboard_history_list")
      .then((list) => setEntries(list))
      .catch((err) => console.warn("clipboard_history_list failed", err));

    let unlisten: UnlistenFn | undefined;
    let stopped = false;
    void listen<ClipEntry>("clipboard:new", (evt) => {
      setEntries((prev) => applyClip(prev, evt.payload));
    })
      .then((u) => {
        // `listen` resolves a turn or two after onMount, so onCleanup can
        // already have run by the time we get the handle.
        if (stopped) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch((err) => console.warn("clipboard:new listen failed", err));

    onCleanup(() => {
      stopped = true;
      unlisten?.();
    });
  });

  async function recopy(entry: ClipEntry) {
    try {
      await writeText(entry.text);
    } catch (err) {
      console.warn("clipboard write failed", err);
    }
  }

  function setEnabled(v: boolean) {
    setEnabledSignal(v);
    setClipboardEnabled(v);
    void invoke("clipboard_history_set_enabled", { enabled: v }).catch((err) =>
      console.warn("clipboard_history_set_enabled failed", err),
    );
  }

  function clear() {
    setEntries([]);
    void invoke("clipboard_history_clear").catch((err) =>
      console.warn("clipboard_history_clear failed", err),
    );
  }

  return { entries, enabled, setEnabled, recopy, clear };
}

const Ctx = createContext<ReturnType<typeof makeClipboardHistoryContext>>();

export function ClipboardHistoryProvider(props: ParentProps) {
  const ctx = makeClipboardHistoryContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useClipboardHistory() {
  const v = useContext(Ctx);
  if (!v)
    throw new Error("useClipboardHistory outside ClipboardHistoryProvider");
  return v;
}
