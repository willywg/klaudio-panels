import { Show } from "solid-js";
import { PanelLeftClose, PanelLeftOpen } from "lucide-solid";
import { useSidebar } from "@/context/sidebar";
import { GitSummaryPill } from "@/components/git-summary-pill";

type Props = {
  hasActiveProject: boolean;
  activeProjectPath: string | null;
};

/** Custom titlebar: 40px height, draggable via `data-tauri-drag-region`.
 *  Reserves 72px on the left for macOS traffic lights (titleBarStyle:
 *  "Overlay" + hiddenTitle: true in tauri.conf.json). The sidebar toggle
 *  sits right after, matching OpenCode / Warp. */
export function Titlebar(props: Props) {
  const sidebar = useSidebar();

  return (
    <header
      class="h-10 shrink-0 flex items-center bg-neutral-950 border-b border-neutral-800 select-none"
      data-tauri-drag-region
    >
      {/* Spacer for traffic lights on macOS. */}
      <div class="w-[72px] h-full shrink-0" data-tauri-drag-region />

      <Show when={props.hasActiveProject}>
        <button
          class="w-8 h-7 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition ml-1"
          onClick={() => sidebar.toggleCollapsed()}
          title={
            sidebar.collapsed()
              ? "Show sidebar (⌘B)"
              : "Hide sidebar (⌘B)"
          }
        >
          {sidebar.collapsed() ? (
            <PanelLeftOpen size={16} strokeWidth={1.75} />
          ) : (
            <PanelLeftClose size={16} strokeWidth={1.75} />
          )}
        </button>
      </Show>

      {/* Remaining space stays draggable. */}
      <div class="flex-1 h-full" data-tauri-drag-region />

      <Show when={props.activeProjectPath}>
        {(p) => (
          <div class="shrink-0 pr-2">
            <GitSummaryPill projectPath={p()} />
          </div>
        )}
      </Show>
    </header>
  );
}
