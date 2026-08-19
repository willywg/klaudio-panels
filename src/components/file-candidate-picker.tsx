import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { answerFilePick, pendingFilePick } from "@/lib/file-picker-bus";
import { iconForFile } from "@/lib/file-icon";

/** Asks which of several matching files to open.
 *
 *  Only appears when a path printed in the terminal matches more than one file
 *  in the project — `app/main.py` under `core/`, `telegram/` and `whatsapp/`.
 *  Nothing in the printed path says which was meant, and opening the wrong
 *  service's file with no error shown is a worse outcome than one extra click.
 *
 *  Mounted once at the app root and driven by `file-picker-bus`, mirroring
 *  `ImageLightbox`. */
export function FileCandidatePicker() {
  const [active, setActive] = createSignal(0);
  let panelRef: HTMLDivElement | undefined;

  // Every new question starts at the top of its own list.
  createEffect(() => {
    if (pendingFilePick()) setActive(0);
  });

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const req = pendingFilePick();
      if (!req) return;
      // While the picker is open every keystroke belongs to it. Capturing at
      // `window` is not enough on its own: `preventDefault` alone lets the
      // event keep capturing down into xterm's textarea, so Enter both picked
      // a candidate AND submitted whatever sat in Claude's prompt, while the
      // arrows walked its history at the same time. Stopping propagation here
      // is what makes the modal actually modal.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        answerFilePick(null);
        return;
      }
      if (e.key === "ArrowDown") {
        setActive((i) => Math.min(i + 1, req.candidates.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        setActive((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        answerFilePick(req.candidates[active()] ?? null);
      }
      // Anything else is swallowed rather than forwarded — a keystroke meant
      // for a modal has no business reaching the terminal behind it.
    };
    // Capture phase: the terminal underneath swallows keys otherwise.
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  function onBackdropClick(e: MouseEvent) {
    if (panelRef && e.target instanceof Node && panelRef.contains(e.target)) {
      return;
    }
    answerFilePick(null);
  }

  return (
    <Show when={pendingFilePick()}>
      {(req) => (
        <div
          class="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm"
          onClick={onBackdropClick}
        >
          <div
            ref={panelRef}
            class="w-[520px] max-w-[86vw] max-h-[70vh] rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl flex flex-col overflow-hidden"
          >
            <div class="px-4 py-3 border-b border-neutral-800">
              <p class="text-[13px] text-neutral-200">
                Several files match{" "}
                <code class="px-1 py-0.5 rounded bg-neutral-800 text-neutral-100">
                  {req().rel}
                </code>
              </p>
              <p class="mt-1 text-[11px] text-neutral-500">
                The path is relative to a directory we can't infer. Pick one —
                this project will remember it.
              </p>
            </div>

            <div class="overflow-y-auto flex-1 py-1">
              <For each={req().candidates}>
                {(path, i) => (
                  <button
                    type="button"
                    class="w-full px-4 py-2 flex items-center gap-2.5 text-left text-[12px] transition"
                    classList={{
                      "bg-neutral-800 text-neutral-100": i() === active(),
                      "text-neutral-300 hover:bg-neutral-800/60":
                        i() !== active(),
                    }}
                    onMouseEnter={() => setActive(i())}
                    onClick={() => answerFilePick(path)}
                  >
                    <FileIcon path={path} />
                    <span class="flex-1 truncate">
                      <span class="text-neutral-500">{dirOf(path)}</span>
                      <span>{baseOf(path)}</span>
                    </span>
                  </button>
                )}
              </For>
            </div>

            <div class="px-4 py-2 border-t border-neutral-800 flex items-center justify-end gap-3 text-[11px] text-neutral-500">
              <span>↑↓ to move · ↵ to open · esc to cancel</span>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

function FileIcon(props: { path: string }) {
  const { Icon, color } = iconForFile(baseOf(props.path));
  return <Icon size={13} strokeWidth={2} class={"shrink-0 " + color} />;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i + 1) : "";
}

function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
