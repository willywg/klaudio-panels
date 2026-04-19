import { PanelLeftClose, PanelLeftOpen } from "lucide-solid";
import { useSidebar } from "@/context/sidebar";

/** Floating toggle button overlaid on the macOS title bar, just past the
 *  traffic lights. Mirrors OpenCode's pattern: the button lives outside the
 *  content so it's reachable even when the sidebar panel is hidden. */
export function TitlebarToggle() {
  const sidebar = useSidebar();
  return (
    <button
      class="fixed top-[6px] left-[78px] z-50 w-7 h-7 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
      onClick={() => sidebar.toggleCollapsed()}
      title={sidebar.collapsed() ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
    >
      {sidebar.collapsed() ? (
        <PanelLeftOpen size={16} strokeWidth={1.75} />
      ) : (
        <PanelLeftClose size={16} strokeWidth={1.75} />
      )}
    </button>
  );
}
