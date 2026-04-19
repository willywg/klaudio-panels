import { For, Show, onCleanup, onMount } from "solid-js";

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
};

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

/** Minimal context menu. Fixed to the viewport at (x, y); closes on
 *  pointerdown outside or Escape. */
export function ContextMenu(props: Props) {
  let ref: HTMLDivElement | undefined;

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!props.open) return;
      if (ref && e.target instanceof Node && !ref.contains(e.target)) {
        props.onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.open) props.onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <Show when={props.open}>
      <div
        ref={ref}
        class="fixed z-50 min-w-[160px] rounded border border-neutral-700 bg-neutral-900 shadow-lg py-1 text-[12px]"
        style={{ left: `${props.x}px`, top: `${props.y}px` }}
      >
        <For each={props.items}>
          {(item) => (
            <button
              class="w-full px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-800 transition"
              onClick={() => {
                item.onClick();
                props.onClose();
              }}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
