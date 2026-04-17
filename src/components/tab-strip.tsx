import { For } from "solid-js";
import type { TerminalTab } from "@/context/terminal";

type Props = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  canOpenNew: boolean;
};

function statusDotClass(status: TerminalTab["status"]): string {
  switch (status) {
    case "running":
      return "bg-green-500";
    case "exited":
      return "bg-neutral-500";
    case "error":
      return "bg-red-500";
  }
}

export function TabStrip(props: Props) {
  return (
    <div class="flex items-stretch h-8 border-b border-neutral-800 bg-neutral-950/80 overflow-x-auto overflow-y-hidden shrink-0">
      <For each={props.tabs}>
        {(tab) => {
          const isActive = () => tab.id === props.activeTabId;
          return (
            <div
              class={
                "group flex items-center gap-2 px-3 min-w-[120px] max-w-[220px] border-r border-neutral-800 cursor-pointer select-none text-[12px] " +
                (isActive()
                  ? "bg-neutral-900 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-900/50 hover:text-neutral-200")
              }
              onClick={() => props.onActivate(tab.id)}
              title={tab.label}
            >
              <span
                class={
                  "inline-block w-1.5 h-1.5 rounded-full shrink-0 " +
                  statusDotClass(tab.status)
                }
              />
              <span class="truncate flex-1">{tab.label}</span>
              <button
                class={
                  "shrink-0 w-4 h-4 rounded flex items-center justify-center text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 " +
                  (isActive() ? "opacity-100" : "opacity-0 group-hover:opacity-100")
                }
                title="Cerrar tab"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(tab.id);
                }}
              >
                <span class="text-[11px] leading-none">×</span>
              </button>
            </div>
          );
        }}
      </For>
      <button
        class="px-3 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900/60 text-[14px] shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={props.onNew}
        disabled={!props.canOpenNew}
        title="Nueva sesión"
      >
        +
      </button>
    </div>
  );
}
