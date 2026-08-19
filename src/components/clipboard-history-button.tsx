import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { ClipboardList, Check, Trash2 } from "lucide-solid";
import { useClipboardHistory, type ClipEntry } from "@/context/clipboard-history";
import { describeClip, previewOf } from "@/lib/clipboard-prefs";
import { relativeTime } from "@/lib/relative-time";

export function ClipboardHistoryButton() {
  const clips = useClipboardHistory();
  const [open, setOpen] = createSignal(false);
  const [justCopied, setJustCopied] = createSignal<number | null>(null);
  let wrapRef: HTMLDivElement | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const entries = createMemo(() => clips.entries());

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!open()) return;
      if (wrapRef && e.target instanceof Node && !wrapRef.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      if (copiedTimer) clearTimeout(copiedTimer);
    });
  });

  function handleCopy(entry: ClipEntry) {
    void clips.recopy(entry);
    setJustCopied(entry.id);
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setJustCopied(null), 1200);
  }

  return (
    <div ref={wrapRef} class="relative flex items-center">
      <button
        type="button"
        class="w-8 h-7 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
        onClick={() => setOpen((v) => !v)}
        aria-label="Clipboard history"
        title="Clipboard history"
        classList={{ "text-neutral-100 bg-neutral-800/60": open() }}
      >
        <ClipboardList size={15} strokeWidth={1.75} />
      </button>

      <Show when={open()}>
        <div class="absolute right-0 top-full mt-1 z-50 w-[360px] max-h-[480px] rounded-md border border-neutral-800 bg-neutral-900 shadow-xl text-[12px] flex flex-col">
          <div class="px-3 py-2 border-b border-neutral-800 flex items-center justify-between gap-2 shrink-0">
            <span class="text-[10px] uppercase tracking-wide text-neutral-500 font-medium">
              Clipboard
            </span>
            <Show when={entries().length > 0}>
              <button
                type="button"
                class="text-[11px] text-neutral-500 hover:text-neutral-200 transition flex items-center gap-1"
                onClick={() => clips.clear()}
                title="Clear history"
              >
                <Trash2 size={11} strokeWidth={1.75} />
                Clear
              </button>
            </Show>
          </div>

          <div class="overflow-y-auto flex-1">
            <Show
              when={entries().length > 0}
              fallback={
                <p class="px-3 py-6 text-center text-[11px] text-neutral-500 leading-relaxed">
                  <Show
                    when={clips.enabled()}
                    fallback="Recording is off. Anything you copy while it is off stays out of here."
                  >
                    Nothing copied yet.
                    <br />
                    Anything that reaches the clipboard shows up here.
                  </Show>
                </p>
              }
            >
              <For each={entries()}>
                {(entry) => (
                  <button
                    type="button"
                    class="w-full text-left px-3 py-2 border-b border-neutral-800/60 last:border-b-0 hover:bg-neutral-800/50 transition flex flex-col gap-1 group"
                    onClick={() => handleCopy(entry)}
                    title="Click to copy again"
                  >
                    <span class="text-neutral-200 line-clamp-2 break-all leading-snug">
                      {previewOf(entry.text)}
                    </span>
                    <span class="text-[10px] text-neutral-500 flex items-center gap-1.5">
                      <span>{relativeTime(entry.copied_at_ms)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{describeClip(entry.text)}</span>
                      <Show when={entry.truncated}>
                        <span
                          class="text-amber-500/80"
                          title="Only the first 64 KB was kept"
                        >
                          · truncated
                        </span>
                      </Show>
                      <Show when={justCopied() === entry.id}>
                        <span class="ml-auto text-emerald-400 flex items-center gap-1">
                          <Check size={10} strokeWidth={2.5} />
                          Copied
                        </span>
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>

          <label class="px-3 py-2 border-t border-neutral-800 flex items-center justify-between gap-2 shrink-0 cursor-pointer">
            <span class="text-[11px] text-neutral-400">Record clipboard</span>
            <input
              type="checkbox"
              class="accent-neutral-300"
              checked={clips.enabled()}
              onChange={(e) => clips.setEnabled(e.currentTarget.checked)}
            />
          </label>
        </div>
      </Show>
    </div>
  );
}
