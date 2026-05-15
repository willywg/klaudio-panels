import { For, createSignal, onCleanup, onMount } from "solid-js";
import { TOAST_EVENT, type ToastDetail } from "@/lib/toast";

export function Toaster() {
  const [items, setItems] = createSignal<ToastDetail[]>([]);

  onMount(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      setItems((prev) => [...prev, detail]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== detail.id));
      }, detail.durationMs);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    onCleanup(() => window.removeEventListener(TOAST_EVENT, onToast));
  });

  return (
    <div class="fixed bottom-4 right-4 z-[110] flex flex-col gap-2 pointer-events-none">
      <For each={items()}>
        {(t) => (
          <div
            class={
              "pointer-events-auto min-w-[240px] max-w-[420px] rounded-md border px-3 py-2 text-[12px] shadow-lg backdrop-blur-sm " +
              (t.kind === "error"
                ? "border-red-500/50 bg-red-950/85 text-red-100"
                : "border-neutral-700 bg-neutral-900/95 text-neutral-100")
            }
          >
            {t.message}
          </div>
        )}
      </For>
    </div>
  );
}
