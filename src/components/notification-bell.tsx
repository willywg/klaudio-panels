import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { ArrowLeft, Bell, BellOff, Settings } from "lucide-solid";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNotifications, type UnreadItem } from "@/context/notifications";
import type { NotificationPrefs } from "@/lib/notifications-prefs";
import { relativeTime } from "@/lib/relative-time";

const WARP_PLUGIN_INSTALL_URL =
  "https://github.com/willywg/klaudio-panels#permission-requests-recommended-warp-plugin";

type View = "list" | "settings";

function projectName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function NotificationBell() {
  const notifications = useNotifications();
  const [open, setOpen] = createSignal(false);
  const [view, setView] = createSignal<View>("list");
  let wrapRef: HTMLDivElement | undefined;

  const items = createMemo(() => notifications.unreadItems());
  const count = createMemo(() => items().length);

  // Every reopen lands on the list — settings is opt-in per session.
  createEffect(() => {
    if (open()) setView("list");
  });

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
          <Show
            when={view() === "settings"}
            fallback={
              <ListView
                items={items()}
                count={count()}
                onItemClick={handleItemClick}
                onMarkAllRead={() => notifications.clearAllItems()}
                onOpenSettings={() => setView("settings")}
              />
            }
          >
            <SettingsView onBack={() => setView("list")} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

function ListView(props: {
  items: readonly UnreadItem[];
  count: number;
  onItemClick: (item: UnreadItem) => void;
  onMarkAllRead: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <div class="px-3 py-2 border-b border-neutral-800 flex items-center justify-between gap-2">
        <span class="text-[10px] uppercase tracking-wide text-neutral-500 font-medium">
          Notifications
        </span>
        <div class="flex items-center gap-1">
          <Show when={props.count > 0}>
            <button
              type="button"
              class="text-[11px] text-neutral-400 hover:text-neutral-100 transition px-1"
              onClick={props.onMarkAllRead}
            >
              Mark all read
            </button>
          </Show>
          <button
            type="button"
            class="w-6 h-6 rounded flex items-center justify-center text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
            onClick={props.onOpenSettings}
            aria-label="Notification settings"
            title="Notification settings"
          >
            <Settings size={13} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <Show
        when={props.count > 0}
        fallback={
          <div class="px-3 py-8 flex flex-col items-center gap-2 text-neutral-500">
            <BellOff size={20} strokeWidth={1.5} />
            <span class="text-[12px]">No notifications</span>
          </div>
        }
      >
        <div class="overflow-y-auto flex-1 py-1">
          <For each={props.items}>
            {(item) => (
              <BellItem item={item} onClick={() => props.onItemClick(item)} />
            )}
          </For>
        </div>
      </Show>
    </>
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

function SettingsView(props: { onBack: () => void }) {
  const notifications = useNotifications();

  // Re-check on mount of the settings view so users who installed the
  // warp plugin without restarting Klaudio see the row enable itself
  // when they reopen ⚙️.
  onMount(() => {
    void notifications.refreshWarpInstalled();
  });

  function toggle(key: keyof NotificationPrefs) {
    notifications.updatePrefs({ [key]: !notifications.prefs()[key] });
  }

  function openInstallDocs() {
    void openUrl(WARP_PLUGIN_INSTALL_URL).catch(() => {});
  }

  // Permission row is gated on the plugin: without it, no events ever
  // arrive and an enabled toggle would lie to the user. Render disabled
  // + visually-off, with a link to the install docs in the helper text.
  const permissionEnabled = () => notifications.warpInstalled();

  const permissionHelp = (): JSX.Element =>
    permissionEnabled() ? (
      <>Notify when Claude needs permission to use a tool (Bash, Edit, …).</>
    ) : (
      <>
        Requires the warp/claude-code-warp plugin.{" "}
        <button
          type="button"
          class="text-indigo-400 hover:text-indigo-300 underline underline-offset-2 transition"
          onClick={openInstallDocs}
        >
          Install →
        </button>
      </>
    );

  return (
    <>
      <div class="px-2 py-2 border-b border-neutral-800 flex items-center gap-1">
        <button
          type="button"
          class="w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
          onClick={props.onBack}
          aria-label="Back to notifications"
          title="Back"
        >
          <ArrowLeft size={13} strokeWidth={1.75} />
        </button>
        <span class="text-[10px] uppercase tracking-wide text-neutral-500 font-medium">
          Settings
        </span>
      </div>
      <div class="overflow-y-auto flex-1 py-1">
        <ToggleRow
          label="Task complete"
          help="Notify after every assistant reply (fires often during long agentic loops)."
          checked={notifications.prefs().notifySessionComplete}
          onToggle={() => toggle("notifySessionComplete")}
        />
        <ToggleRow
          label="Permission requests"
          help={permissionHelp()}
          checked={
            permissionEnabled() && notifications.prefs().notifyPermission
          }
          onToggle={() => toggle("notifyPermission")}
          disabled={!permissionEnabled()}
        />
        <ToggleRow
          label="Sounds"
          help="Play a chime with each notification."
          checked={notifications.prefs().playSounds}
          onToggle={() => toggle("playSounds")}
        />
      </div>
    </>
  );
}

function ToggleRow(props: {
  label: string;
  help: JSX.Element;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      class="px-3 py-2 flex items-start justify-between gap-3"
      classList={{ "opacity-60": props.disabled }}
    >
      <div class="flex-1 min-w-0">
        <div class="text-[12px] text-neutral-100 font-medium">{props.label}</div>
        <div class="text-[11px] text-neutral-400 mt-0.5">{props.help}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-disabled={props.disabled || undefined}
        aria-label={props.label}
        onClick={() => {
          if (props.disabled) return;
          props.onToggle();
        }}
        disabled={props.disabled}
        class="shrink-0 mt-0.5 w-9 h-5 rounded-full transition relative"
        classList={{
          "bg-emerald-500/80": props.checked && !props.disabled,
          "bg-neutral-700": !props.checked || props.disabled,
          "cursor-not-allowed": props.disabled,
        }}
      >
        <span
          class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all"
          classList={{
            "left-[18px]": props.checked,
            "left-0.5": !props.checked,
          }}
        />
      </button>
    </div>
  );
}
