import { ChevronRight, FolderTree, MessagesSquare } from "lucide-solid";
import type { SidebarTab } from "@/lib/sidebar-prefs";

type Props = {
  onExpand: () => void;
  onExpandInto: (tab: SidebarTab) => void;
};

/** Collapsed sidebar: 36px vertical rail with chevron + tab shortcuts.
 *  Picked 36px (not 12px) so the collapsed surface stays discoverable — a
 *  12px rail is easy to miss on a busy window. */
export function SidebarRail(props: Props) {
  return (
    <div class="w-9 shrink-0 border-r border-neutral-800 bg-neutral-950 flex flex-col items-center py-2 gap-1">
      <button
        class="w-7 h-7 rounded flex items-center justify-center text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900 transition"
        title="Expand sidebar (⌘B)"
        onClick={props.onExpand}
      >
        <ChevronRight size={14} strokeWidth={2} />
      </button>
      <div class="w-6 h-px bg-neutral-800 my-1" />
      <button
        class="w-7 h-7 rounded flex items-center justify-center text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900 transition"
        title="Sessions"
        onClick={() => props.onExpandInto("sessions")}
      >
        <MessagesSquare size={14} strokeWidth={2} />
      </button>
      <button
        class="w-7 h-7 rounded flex items-center justify-center text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900 transition"
        title="Files"
        onClick={() => props.onExpandInto("files")}
      >
        <FolderTree size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
