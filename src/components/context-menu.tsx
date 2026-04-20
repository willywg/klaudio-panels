import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { Check, ChevronRight, type LucideProps } from "lucide-solid";
import type { Component } from "solid-js";

type IconFields = {
  icon?: Component<LucideProps>;
  iconUrl?: string;
  iconClass?: string;
};

export type ContextMenuItem =
  | ({
      kind?: "action";
      label: string;
      onClick: () => void;
      disabled?: boolean;
      /** Renders a check mark on the trailing edge (used to mark the
       *  current default terminal editor). */
      checked?: boolean;
    } & IconFields)
  | { kind: "divider" }
  | ({
      kind: "submenu";
      label: string;
      items: ContextMenuItem[];
    } & IconFields);

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

function ItemIcon(props: { icon?: IconFields }) {
  const fields = () => props.icon ?? {};
  const url = () => fields().iconUrl;
  const Icon = () => fields().icon;
  return (
    <Show
      when={url()}
      fallback={
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
                class={"shrink-0 " + (fields().iconClass ?? "text-neutral-400")}
              />
            );
          }}
        </Show>
      }
    >
      {(src) => (
        <img
          src={src()}
          alt=""
          class="shrink-0 rounded-sm"
          style={{ width: "14px", height: "14px" }}
        />
      )}
    </Show>
  );
}

function ActionRow(props: {
  item: Extract<ContextMenuItem, { kind?: "action" }>;
  onClose: () => void;
}) {
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
      <ItemIcon icon={props.item} />
      <span class="flex-1 truncate">{props.item.label}</span>
      <Show when={props.item.checked}>
        <Check size={12} strokeWidth={2.25} class="shrink-0 text-neutral-400" />
      </Show>
    </button>
  );
}

function SubmenuRow(props: {
  item: Extract<ContextMenuItem, { kind: "submenu" }>;
  onClose: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  let closeTimer: number | undefined;

  function scheduleOpen() {
    if (closeTimer !== undefined) {
      window.clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    setOpen(true);
  }

  /** Debounce the close so the cursor has time to traverse the pixel gap
   *  between the row and the flyout. Without this, moving the mouse
   *  diagonally towards a submenu item closes the whole flyout mid-traversal. */
  function scheduleClose() {
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => setOpen(false), 180);
  }

  onCleanup(() => {
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
  });

  return (
    <div
      class="relative"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <div class="w-full px-3 py-1.5 flex items-center gap-2.5 text-left text-neutral-200 hover:bg-neutral-800 transition cursor-default">
        <ItemIcon icon={props.item} />
        <span class="flex-1 truncate">{props.item.label}</span>
        <ChevronRight size={12} strokeWidth={2} class="text-neutral-500 shrink-0" />
      </div>
      <Show when={open()}>
        {/* No `ml-0.5` — a hairline gap (even 2px) breaks pointer tracking
            through the submenu. We keep the flyout flush and instead use
            padding inside it for visual separation. */}
        <div
          class="absolute left-full top-0 min-w-[200px] rounded-md border border-neutral-700 bg-neutral-900 shadow-xl py-1 text-[12px] z-50"
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
        >
          <MenuBody items={props.item.items} onClose={props.onClose} />
        </div>
      </Show>
    </div>
  );
}
