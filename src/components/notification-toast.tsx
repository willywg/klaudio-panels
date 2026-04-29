import { For } from "solid-js";
import { X } from "lucide-solid";
import { useNotifications, type Toast } from "@/context/notifications";

export function NotificationToastStack() {
  const notifications = useNotifications();
  return (
    <div
      class="fixed top-12 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      <For each={notifications.toasts()}>
        {(toast) => <NotificationToast toast={toast} />}
      </For>
    </div>
  );
}

function NotificationToast(props: { toast: Toast }) {
  const notifications = useNotifications();
  const isPermission = () => props.toast.kind === "permission";

  return (
    <div
      role="status"
      class={`pointer-events-auto relative w-80 rounded-md border bg-neutral-900/95 backdrop-blur px-3 py-2.5 pr-7 text-sm shadow-xl ${
        isPermission()
          ? "border-amber-400/60 ring-1 ring-amber-400/30"
          : "border-neutral-700/70"
      }`}
      style="animation: klaudio-toast-in 180ms ease-out both"
    >
      <button
        type="button"
        class="absolute top-1.5 right-1.5 p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          notifications.dismissToast(props.toast.id);
        }}
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
      <button
        type="button"
        class="block w-full text-left cursor-pointer"
        onClick={() => notifications.activateAndDismiss(props.toast)}
      >
        <div class="font-medium text-neutral-100 truncate">
          {props.toast.title}
        </div>
        <div class="mt-0.5 text-xs text-neutral-300 line-clamp-2 break-words">
          {props.toast.body}
        </div>
      </button>
    </div>
  );
}
