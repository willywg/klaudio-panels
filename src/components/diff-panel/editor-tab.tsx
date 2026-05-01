import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDiffPanel } from "@/context/diff-panel";
import { useEditBuffers } from "@/context/edit-buffers";
import { confirmDialog } from "@/components/confirm-dialog";
import { toast } from "@/lib/toast";
import { baseExtensions, loadCMCore } from "@/lib/cm-singleton";
import { languageExtensionFor } from "@/lib/cm-language";
import type {
  FsEvent,
  FsEventEnvelope,
} from "@/components/file-tree/use-file-tree";

type FilePayload = {
  path: string;
  contents: string | null;
  is_binary: boolean;
  too_large: boolean;
  bytes: number;
  mtime_ms: number;
};

type WriteResult = { bytes: number; mtime_ms: number };

type Props = {
  projectPath: string;
  relPath: string;
  /** Whether this tab is the visible one. Used to refocus the editor on
   *  re-activation so ⌘S routes through CodeMirror's keymap. */
  active: boolean;
};

type LoadStatus = "loading" | "ready" | "error" | "rejected";

export function EditorTab(props: Props) {
  const panel = useDiffPanel();
  const buffers = useEditBuffers();

  const [status, setStatus] = createSignal<LoadStatus>("loading");
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [externalChanged, setExternalChanged] = createSignal(false);

  let host: HTMLDivElement | undefined;
  let view: import("@codemirror/view").EditorView | null = null;
  let cmCore: Awaited<ReturnType<typeof loadCMCore>> | null = null;

  // Saved state needed for save / external-change checks. Kept in plain
  // refs because save() reads them outside of the reactive scope.
  let baseline = "";
  let baselineMtime = 0;

  let unlistenFs: UnlistenFn | null = null;
  let unregisterGuard: (() => void) | null = null;
  let disposed = false;

  // Tracks the currently-running save IPC. Lets the close-guard wait for an
  // in-flight save before deciding "dirty?" — without this, ⌘S followed
  // immediately by a tab-close click races the IPC: the buffer is still
  // dirty when the guard checks, the confirm dialog pops, and the user is
  // left wondering why a saved file is asking to be saved.
  let savingPromise: Promise<void> | null = null;

  function projectAndRel(): { p: string; r: string } {
    return { p: props.projectPath, r: props.relPath };
  }

  function currentDoc(): string {
    return view ? view.state.doc.toString() : baseline;
  }

  function recomputeDirty(doc: string) {
    const { p, r } = projectAndRel();
    buffers.markDirty(p, r, doc !== baseline);
  }

  async function load() {
    setStatus("loading");
    setErrorMsg(null);
    try {
      const payload = await invoke<FilePayload>("read_file_bytes", {
        projectPath: props.projectPath,
        relPath: props.relPath,
      });
      if (disposed) return;
      if (payload.too_large) {
        setErrorMsg("File exceeds 1 MiB — open externally to edit.");
        setStatus("rejected");
        return;
      }
      if (payload.is_binary || payload.contents === null) {
        setErrorMsg("Binary or non-UTF-8 file — not editable.");
        setStatus("rejected");
        return;
      }
      baseline = payload.contents;
      baselineMtime = payload.mtime_ms;
      buffers.register(props.projectPath, props.relPath, baseline, baselineMtime);
      await mountEditor(payload.contents);
      if (disposed) return;
      setStatus("ready");
    } catch (err) {
      if (disposed) return;
      setErrorMsg(String(err));
      setStatus("error");
    }
  }

  async function mountEditor(initial: string) {
    cmCore = await loadCMCore();
    const langExt = await languageExtensionFor(props.relPath);
    if (disposed || !host) return;

    const exts = baseExtensions(cmCore, {
      onSave: () => void save(),
      onDocChanged: (doc) => recomputeDirty(doc),
    });
    if (langExt) exts.push(langExt);

    const state = cmCore.EditorState.create({
      doc: initial,
      extensions: exts,
    });
    view = new cmCore.EditorView({ state, parent: host });

    if (props.active) {
      // Defer focus a frame so the visibility flip completes first.
      requestAnimationFrame(() => view?.focus());
    }
  }

  async function save(): Promise<void> {
    // Coalesce concurrent saves — if one is in flight, just await it.
    if (savingPromise) return savingPromise;
    const { p, r } = projectAndRel();
    const buf = buffers.get(p, r);
    if (!buf) return;
    const doc = currentDoc();
    if (doc === baseline) return; // not dirty, no-op
    buffers.setSaving(p, r, true);
    const promise = (async () => {
      try {
        const result = await invoke<WriteResult>("write_file_bytes", {
          projectPath: p,
          relPath: r,
          contents: doc,
          expectedMtimeMs: baselineMtime,
        });
        baseline = doc;
        baselineMtime = result.mtime_ms;
        buffers.updateBaseline(p, r, doc, result.mtime_ms);
        setExternalChanged(false);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("stale")) {
          setExternalChanged(true);
          toast(
            "File changed on disk. Reload first or use 'Keep mine' to overwrite.",
            "error",
          );
        } else {
          toast(`Save failed: ${msg}`, "error");
        }
      } finally {
        buffers.setSaving(p, r, false);
      }
    })();
    savingPromise = promise;
    try {
      await promise;
    } finally {
      if (savingPromise === promise) savingPromise = null;
    }
  }

  /** Force-write the current buffer ignoring the on-disk mtime. Wired up
   *  to the "Keep mine" button on the external-change banner. */
  async function saveOverwrite(): Promise<void> {
    if (savingPromise) return savingPromise;
    const { p, r } = projectAndRel();
    const buf = buffers.get(p, r);
    if (!buf) return;
    const doc = currentDoc();
    buffers.setSaving(p, r, true);
    const promise = (async () => {
      try {
        const result = await invoke<WriteResult>("write_file_bytes", {
          projectPath: p,
          relPath: r,
          contents: doc,
          // No expectedMtimeMs — explicit clobber.
        });
        baseline = doc;
        baselineMtime = result.mtime_ms;
        buffers.updateBaseline(p, r, doc, result.mtime_ms);
        setExternalChanged(false);
      } catch (err) {
        toast(`Save failed: ${String(err)}`, "error");
      } finally {
        buffers.setSaving(p, r, false);
      }
    })();
    savingPromise = promise;
    try {
      await promise;
    } finally {
      if (savingPromise === promise) savingPromise = null;
    }
  }

  async function reload() {
    try {
      const payload = await invoke<FilePayload>("read_file_bytes", {
        projectPath: props.projectPath,
        relPath: props.relPath,
      });
      if (payload.is_binary || payload.contents === null) {
        toast("File is no longer text — closing editor.", "error");
        void panel.closeTab(props.projectPath, `edit:${props.relPath}`);
        return;
      }
      baseline = payload.contents;
      baselineMtime = payload.mtime_ms;
      buffers.updateBaseline(
        props.projectPath,
        props.relPath,
        payload.contents,
        payload.mtime_ms,
      );
      if (view && cmCore) {
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: payload.contents,
          },
        });
      }
      setExternalChanged(false);
    } catch (err) {
      toast(`Reload failed: ${String(err)}`, "error");
    }
  }

  /** Subscribe to fs events for the project. When the user's open file is
   *  touched on disk, fetch the fresh mtime; if it differs from our
   *  baseline AND the buffer is dirty, surface the banner. Clean buffers
   *  reload silently. */
  async function attachFsListener() {
    const { p, r } = projectAndRel();
    const target = `${p.replace(/\/+$/, "")}/${r}`;
    unlistenFs = await listen<FsEventEnvelope>("fs-event", async (e) => {
      if (disposed) return;
      const env = e.payload;
      if (env.project_path !== p) return;
      const ev = env as FsEvent;
      let touched: string | null = null;
      if (ev.kind === "modified" || ev.kind === "created") {
        touched = ev.path;
      } else if (ev.kind === "renamed") {
        touched = ev.to;
      } else if (ev.kind === "removed") {
        touched = ev.path;
      }
      if (touched !== target) return;

      // Re-stat to learn the new mtime. If it equals our baseline (race
      // where our own save's event arrives back), no-op.
      try {
        const fresh = await invoke<FilePayload>("read_file_bytes", {
          projectPath: p,
          relPath: r,
        });
        if (disposed) return;
        if (fresh.mtime_ms === baselineMtime) return;
        const doc = currentDoc();
        const isDirty = doc !== baseline;
        if (!isDirty) {
          // Silent reload.
          if (fresh.contents !== null) {
            baseline = fresh.contents;
            baselineMtime = fresh.mtime_ms;
            buffers.updateBaseline(p, r, fresh.contents, fresh.mtime_ms);
            if (view && cmCore) {
              view.dispatch({
                changes: {
                  from: 0,
                  to: view.state.doc.length,
                  insert: fresh.contents,
                },
              });
            }
          }
        } else {
          setExternalChanged(true);
        }
      } catch {
        // Most likely the file vanished mid-stat — surface as banner so
        // the user notices, instead of silently swallowing.
        setExternalChanged(true);
      }
    });
  }

  /** Close-guard: returns "keep" to abort the close, "close" to proceed.
   *  When dirty, prompts Save / Discard / Cancel. */
  async function closeGuard(): Promise<"close" | "keep"> {
    const { p, r } = projectAndRel();
    // Wait for any in-flight save to settle before deciding. Errors already
    // surfaced through save()'s toast — we only care about reading the
    // final dirty state.
    if (savingPromise) {
      try {
        await savingPromise;
      } catch {
        /* ignored — surfaced via toast */
      }
    }
    if (!buffers.dirty(p, r)) return "close";
    const choice = await confirmDialog<"save" | "discard" | "cancel">({
      title: "Unsaved changes",
      body: `${r}\n\nThis file has unsaved edits. What would you like to do?`,
      buttons: [
        { id: "cancel", label: "Cancel", variant: "neutral" },
        { id: "discard", label: "Discard", variant: "danger" },
        { id: "save", label: "Save", variant: "primary" },
      ],
    });
    if (choice === "save") {
      await save();
      // If save failed (stale / IO), the buffer is still dirty — bail.
      if (buffers.dirty(p, r)) return "keep";
      return "close";
    }
    if (choice === "discard") return "close";
    return "keep";
  }

  onMount(() => {
    unregisterGuard = panel.registerCloseGuard(
      `edit:${props.relPath}`,
      closeGuard,
    );
    void load();
    void attachFsListener();
  });

  // Refocus the editor whenever the tab becomes active, so ⌘S routes
  // through CodeMirror's keymap without a manual click first.
  let firstActiveRun = true;
  createEffect(() => {
    const active = props.active;
    if (firstActiveRun) {
      firstActiveRun = false;
      return;
    }
    if (active) requestAnimationFrame(() => view?.focus());
  });

  onCleanup(() => {
    disposed = true;
    if (unregisterGuard) unregisterGuard();
    if (unlistenFs) unlistenFs();
    buffers.unregister(props.projectPath, props.relPath);
    if (view) {
      view.destroy();
      view = null;
    }
  });

  return (
    <div class="h-full w-full flex flex-col min-h-0 bg-neutral-950">
      <Show when={externalChanged()}>
        <div class="shrink-0 flex items-center gap-3 px-3 h-8 border-b border-amber-700/60 bg-amber-950/40 text-[12px] text-amber-200">
          <span class="flex-1 truncate">
            File changed on disk.
          </span>
          <button
            class="px-2 h-6 rounded border border-amber-600/50 hover:bg-amber-800/40 text-amber-100"
            onClick={() => void reload()}
          >
            Reload
          </button>
          <button
            class="px-2 h-6 rounded border border-amber-600/30 hover:bg-amber-800/20 text-amber-200/90"
            onClick={() => void saveOverwrite()}
          >
            Keep mine
          </button>
        </div>
      </Show>
      <Show when={status() === "loading"}>
        <div class="flex-1 flex items-center justify-center text-[12px] text-neutral-500">
          Loading…
        </div>
      </Show>
      <Show when={status() === "error" || status() === "rejected"}>
        <div class="flex-1 flex items-center justify-center px-6 text-[12px] text-neutral-400 text-center whitespace-pre-line">
          {errorMsg() ?? "Failed to open file."}
        </div>
      </Show>
      <div
        ref={host}
        class="flex-1 min-h-0 overflow-auto"
        style={{
          display: status() === "ready" ? undefined : "none",
        }}
      />
    </div>
  );
}
