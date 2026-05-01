import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

export type ConfirmButton<R extends string> = {
  id: R;
  label: string;
  /** "primary" reserves the indigo accent; "danger" the red accent. */
  variant?: "primary" | "danger" | "neutral";
};

type Props<R extends string> = {
  open: boolean;
  title: string;
  body: string;
  buttons: ConfirmButton<R>[];
  onResolve: (id: R | null) => void;
};

/** Minimal modal dialog. Centered overlay, dark surface, button row.
 *  Escape resolves with `null`; click on the dim backdrop also resolves
 *  null. The dialog never auto-dismisses — callers always get exactly one
 *  resolve call. */
export function ConfirmDialog<R extends string>(props: Props<R>) {
  let panelRef: HTMLDivElement | undefined;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!props.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        props.onResolve(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  function onBackdropClick(e: MouseEvent) {
    if (panelRef && e.target instanceof Node && panelRef.contains(e.target)) {
      return;
    }
    props.onResolve(null);
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm"
        onClick={onBackdropClick}
      >
        <div
          ref={panelRef}
          class="min-w-[320px] max-w-[440px] rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl p-4 text-[12.5px] text-neutral-200"
        >
          <div class="font-semibold text-[13px] mb-1.5 text-neutral-100">
            {props.title}
          </div>
          <div class="whitespace-pre-line text-neutral-300 mb-4 leading-snug">
            {props.body}
          </div>
          <div class="flex gap-2 justify-end">
            <For each={props.buttons}>
              {(btn) => (
                <button
                  type="button"
                  class={
                    "px-3 h-7 rounded text-[12px] transition border " +
                    (btn.variant === "danger"
                      ? "border-red-600/60 bg-red-600/15 hover:bg-red-600/25 text-red-200"
                      : btn.variant === "primary"
                        ? "border-indigo-600/60 bg-indigo-600/20 hover:bg-indigo-600/35 text-indigo-100"
                        : "border-neutral-700 hover:bg-neutral-800 text-neutral-200")
                  }
                  onClick={() => props.onResolve(btn.id)}
                >
                  {btn.label}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}

/** Helper: imperative `await confirmDialog({...})` — renders a transient
 *  ConfirmDialog into a portal-style div and resolves the promise once
 *  the user picks (or dismisses). One in-flight dialog at a time. */
export async function confirmDialog<R extends string>(opts: {
  title: string;
  body: string;
  buttons: ConfirmButton<R>[];
}): Promise<R | null> {
  return new Promise<R | null>((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const [open, setOpen] = createSignal(true);

    // Mount via Solid's render. Imported here (top-level import would be
    // unused when callers don't reach this branch) — but the static import
    // is fine because `confirmDialog` is small and likely tree-shaken if
    // unused.
    void import("solid-js/web").then(({ render }) => {
      const dispose = render(
        () => (
          <ConfirmDialog
            open={open()}
            title={opts.title}
            body={opts.body}
            buttons={opts.buttons}
            onResolve={(id) => {
              setOpen(false);
              // Belt-and-suspenders: drop pointer-events on the host the
              // moment we start tearing down. Even if the Show inside takes
              // a frame to unmount, or a downstream cleanup throws and
              // host.remove() never runs, the overlay can no longer
              // intercept clicks and freeze the whole UI.
              host.style.pointerEvents = "none";
              // Defer disposal a frame so the click event finishes
              // bubbling on the disappearing button.
              requestAnimationFrame(() => {
                try {
                  dispose();
                } catch (err) {
                  console.warn("ConfirmDialog dispose failed", err);
                } finally {
                  host.remove();
                  resolve(id);
                }
              });
            }}
          />
        ),
        host,
      );
    });
  });
}
