import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { ChevronDown, Check, ExternalLink } from "lucide-solid";
import { useOpenIn } from "@/context/open-in";
import type { OpenInApp } from "@/lib/open-in";
import { AppIcon } from "@/components/app-icon";

type Props = {
  /** Absolute path to open. Usually the active project dir but generic. */
  path: string;
};

export function OpenInDropdown(props: Props) {
  const openIn = useOpenIn();
  const [menuOpen, setMenuOpen] = createSignal(false);
  let wrapRef: HTMLDivElement | undefined;

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!menuOpen()) return;
      if (wrapRef && e.target instanceof Node && !wrapRef.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    });
  });

  function openWith(app: OpenInApp) {
    void openIn.openPath(props.path, app.id);
    setMenuOpen(false);
  }

  function openCurrent() {
    void openIn.openPath(props.path);
  }

  return (
    <div ref={wrapRef} class="relative flex items-center">
      <div class="h-6 flex items-center rounded-md border border-neutral-800 bg-neutral-900/70 hover:border-neutral-700 transition overflow-hidden">
        <button
          onClick={openCurrent}
          class="h-full px-2 flex items-center gap-1.5 text-[11px] text-neutral-300 hover:text-neutral-100 hover:bg-neutral-800 transition"
          title={`Open in ${openIn.resolveCurrent().label}`}
        >
          <AppIcon app={openIn.resolveCurrent()} size={14} />
          <span class="font-medium truncate max-w-[88px]">
            {openIn.resolveCurrent().label}
          </span>
        </button>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          class="h-full px-1.5 flex items-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition border-l border-neutral-800"
          title="Choose app"
        >
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </div>

      <Show when={menuOpen()}>
        <div class="absolute right-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-neutral-800 bg-neutral-900 shadow-xl py-1 text-[12px]">
          <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-500 font-medium">
            Open in
          </div>
          <For each={openIn.availableApps().filter((a) => !a.terminalEditor)}>
            {(app) => {
              const isActive = () => openIn.resolveCurrent().id === app.id;
              return (
                <button
                  class="w-full px-3 py-1.5 flex items-center gap-2.5 text-left text-neutral-200 hover:bg-neutral-800 transition"
                  onClick={() => openWith(app)}
                >
                  <AppIcon app={app} size={16} />
                  <span class="flex-1 truncate">{app.label}</span>
                  <Show when={isActive()}>
                    <Check size={12} strokeWidth={2.25} class="text-neutral-400" />
                  </Show>
                </button>
              );
            }}
          </For>
          <div class="mt-1 pt-1 border-t border-neutral-800">
            <button
              class="w-full px-3 py-1.5 flex items-center gap-2.5 text-left text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition"
              onClick={() => {
                void navigator.clipboard.writeText(props.path);
                setMenuOpen(false);
              }}
            >
              <ExternalLink size={12} strokeWidth={2} class="shrink-0" />
              <span class="flex-1 truncate">Copy path</span>
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
