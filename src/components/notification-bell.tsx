import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Bell, BellOff } from "lucide-solid";
import { useNotifications, type UnreadItem } from "@/context/notifications";
import { relativeTime } from "@/lib/relative-time";

function projectName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function NotificationBell() {
  const notifications = useNotifications();
  const [open, setOpen] = createSignal(false);
  let wrapRef: HTMLDivElement | undefined;

  const items = createMemo(() => notifications.unreadItems());
  const count = createMemo(() => items().length);

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
    });
  });

  function handleItemClick(item: UnreadItem) {
    notifications.activateProjectFromBell(item.projectPath);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} class="relative flex items-center">
      <button
        type="button"
        class="w-8 h-7 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition relative"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        title="Notifications"
        classList={{ "text-neutral-100 bg-neutral-800/60": open() }}
      >
        <Bell size={15} strokeWidth={1.75} />
        <Show when={count() > 0}>
          <span class="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex items-center justify-center pointer-events-none">
            {count() > 9 ? "9+" : count()}
          </span>
        </Show>
      </button>

      <Show when={open()}>
        <div class="absolute right-0 top-full mt-1 z-50 w-[360px] max-h-[480px] rounded-md border border-neutral-800 bg-neutral-900 shadow-xl text-[12px] flex flex-col">
          <div class="px-3 py-2 border-b border-neutral-800 flex items-center justify-between">
            <span class="text-[10px] uppercase tracking-wide text-neutral-500 font-medium">
              Notifications
            </span>
            <Show when={count() > 0}>
              <button
                type="button"
                class="text-[11px] text-neutral-400 hover:text-neutral-100 transition"
                onClick={() => notifications.clearAllItems()}
              >
                Mark all read
              </button>
            </Show>
          </div>

          <Show
            when={count() > 0}
            fallback={
              <div class="px-3 py-8 flex flex-col items-center gap-2 text-neutral-500">
                <BellOff size={20} strokeWidth={1.5} />
                <span class="text-[12px]">No notifications</span>
              </div>
            }
          >
            <div class="overflow-y-auto flex-1 py-1">
              <For each={items()}>
                {(item) => (
                  <BellItem item={item} onClick={() => handleItemClick(item)} />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function BellItem(props: { item: UnreadItem; onClick: () => void }) {
  const isPermission = () => props.item.kind === "permission";
  return (
    <button
      type="button"
      class="w-full px-3 py-2 flex items-start gap-2.5 text-left hover:bg-neutral-800/60 transition cursor-pointer"
      onClick={props.onClick}
    >
      <span
        class={`shrink-0 w-1 self-stretch rounded-full ${
          isPermission() ? "bg-amber-400/80" : "bg-indigo-400/60"
        }`}
        aria-hidden="true"
      />
      <span class="flex-1 min-w-0">
        <span class="flex items-baseline gap-2 justify-between">
          <span class="font-medium text-neutral-100 truncate">
            {projectName(props.item.projectPath)}
          </span>
          <span class="text-[10px] text-neutral-500 shrink-0">
            {relativeTime(props.item.createdAt)}
          </span>
        </span>
        <span class="block mt-0.5 text-[12px] text-neutral-200 line-clamp-1">
          {props.item.title.split(" · ").slice(1).join(" · ") || props.item.title}
        </span>
        <span class="block mt-0.5 text-[11px] text-neutral-400 line-clamp-2 break-words">
          {props.item.body}
        </span>
      </span>
    </button>
  );
}
