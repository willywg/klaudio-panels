import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { ChevronRight, type LucideProps } from "lucide-solid";
import type { Component } from "solid-js";

export type ContextMenuItem =
  | {
      kind?: "action";
      label: string;
      icon?: Component<LucideProps>;
      iconClass?: string;
      onClick: () => void;
      disabled?: boolean;
    }
  | { kind: "divider" }
  | {
      kind: "submenu";
      label: string;
      icon?: Component<LucideProps>;
      iconClass?: string;
      items: ContextMenuItem[];
    };

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

/** Minimal context menu with optional submenus + dividers. Fixed to the
 *  viewport at (x, y); closes on pointerdown outside or Escape. */
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
        class="fixed z-50 min-w-[200px] rounded-md border border-neutral-700 bg-neutral-900 shadow-xl py-1 text-[12px]"
        style={{ left: `${props.x}px`, top: `${props.y}px` }}
      >
        <MenuBody items={props.items} onClose={props.onClose} />
      </div>
    </Show>
  );
}

function MenuBody(props: { items: ContextMenuItem[]; onClose: () => void }) {
  return (
    <For each={props.items}>
      {(item) => (
        <Switch>
          <Match when={item.kind === "divider"}>
            <div class="my-1 border-t border-neutral-800" />
          </Match>
          <Match when={item.kind === "submenu"}>
            <SubmenuRow
              item={item as Extract<ContextMenuItem, { kind: "submenu" }>}
              onClose={props.onClose}
            />
          </Match>
          <Match when={!item.kind || item.kind === "action"}>
            <ActionRow
              item={item as Extract<ContextMenuItem, { kind?: "action" }>}
              onClose={props.onClose}
            />
          </Match>
        </Switch>
      )}
    </For>
  );
}

function ActionRow(props: {
  item: Extract<ContextMenuItem, { kind?: "action" }>;
  onClose: () => void;
}) {
  const Icon = () => props.item.icon;
  return (
    <button
      class={
        "w-full px-3 py-1.5 flex items-center gap-2.5 text-left transition " +
        (props.item.disabled
          ? "text-neutral-600 cursor-default"
          : "text-neutral-200 hover:bg-neutral-800")
      }
      disabled={props.item.disabled}
      onClick={() => {
        if (props.item.disabled) return;
        props.item.onClick();
        props.onClose();
      }}
    >
      <Show
        when={Icon()}
        fallback={<span class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      >
        {(I) => {
          const C = I();
          return (
            <C
              size={14}
              strokeWidth={2}
              class={"shrink-0 " + (props.item.iconClass ?? "text-neutral-400")}
            />
          );
        }}
      </Show>
      <span class="flex-1 truncate">{props.item.label}</span>
    </button>
  );
}

function SubmenuRow(props: {
  item: Extract<ContextMenuItem, { kind: "submenu" }>;
  onClose: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  let rowRef: HTMLDivElement | undefined;
  const Icon = () => props.item.icon;

  return (
    <div
      ref={rowRef}
      class="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div class="w-full px-3 py-1.5 flex items-center gap-2.5 text-left text-neutral-200 hover:bg-neutral-800 transition cursor-default">
        <Show
          when={Icon()}
          fallback={<span class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
        >
          {(I) => {
            const C = I();
            return (
              <C
                size={14}
                strokeWidth={2}
                class={"shrink-0 " + (props.item.iconClass ?? "text-neutral-400")}
              />
            );
          }}
        </Show>
        <span class="flex-1 truncate">{props.item.label}</span>
        <ChevronRight size={12} strokeWidth={2} class="text-neutral-500 shrink-0" />
      </div>
      <Show when={open()}>
        <div class="absolute left-full top-0 ml-0.5 min-w-[200px] rounded-md border border-neutral-700 bg-neutral-900 shadow-xl py-1 text-[12px] z-50">
          <MenuBody items={props.item.items} onClose={props.onClose} />
        </div>
      </Show>
    </div>
  );
}
