import { Show } from "solid-js";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SquareTerminal,
} from "lucide-solid";
import { useSidebar } from "@/context/sidebar";
import { useShellPanel } from "@/context/shell-panel";
import { useCommandPalette } from "@/context/command-palette";
import { GitSummaryPill } from "@/components/git-summary-pill";
import { OpenInDropdown } from "@/components/open-in-dropdown";
import { NotificationBell } from "@/components/notification-bell";

function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

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
  const shellPanel = useShellPanel();
  const palette = useCommandPalette();

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

      {/* Remaining space stays draggable; the search pill in the middle
          breaks drag at the button itself. */}
      <div
        class="flex-1 h-full flex items-center justify-center"
        data-tauri-drag-region
      >
        <Show when={props.activeProjectPath}>
          {(p) => (
            <button
              class="h-7 w-[280px] max-w-[40vw] px-2.5 rounded-md bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-700 transition flex items-center gap-2 text-[12px] text-neutral-500 hover:text-neutral-300"
              onClick={() => palette.open()}
              title="Search sessions and files (⌘K)"
            >
              <Search size={12} strokeWidth={2} class="shrink-0" />
              <span class="truncate flex-1 text-left">
                Search {basename(p())}
              </span>
              <span class="shrink-0 text-neutral-600 text-[11px]">⌘K</span>
            </button>
          )}
        </Show>
      </div>

      <div class="shrink-0 pr-2 flex items-center gap-2">
        <Show when={props.activeProjectPath}>
          {(p) => (
            <>
              <GitSummaryPill projectPath={p()} />
              <button
                class="w-8 h-7 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
                onClick={() => shellPanel.toggleFor(p())}
                title={
                  shellPanel.openedFor(p())
                    ? "Hide terminal (⌘J)"
                    : "Show terminal (⌘J)"
                }
                classList={{
                  "text-neutral-100 bg-neutral-800/60": shellPanel.openedFor(
                    p(),
                  ),
                }}
              >
                <SquareTerminal size={15} strokeWidth={1.75} />
              </button>
              <OpenInDropdown path={p()} />
            </>
          )}
        </Show>
        <NotificationBell />
      </div>
    </header>
  );
}
