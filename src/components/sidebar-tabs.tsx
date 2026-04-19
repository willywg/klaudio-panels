import { ChevronLeft, FolderTree, MessagesSquare } from "lucide-solid";
import type { SidebarTab } from "@/lib/sidebar-prefs";

type Props = {
  active: SidebarTab;
  onChange: (tab: SidebarTab) => void;
  onCollapse: () => void;
};

export function SidebarTabs(props: Props) {
  return (
    <div class="flex items-stretch h-8 border-b border-neutral-800 bg-neutral-950/40 text-[11px]">
      <TabButton
        label="Sessions"
        icon={<MessagesSquare size={12} strokeWidth={2} />}
        active={props.active === "sessions"}
        onClick={() => props.onChange("sessions")}
      />
      <TabButton
        label="Files"
        icon={<FolderTree size={12} strokeWidth={2} />}
        active={props.active === "files"}
        onClick={() => props.onChange("files")}
      />
      <div class="flex-1" />
      <button
        class="px-2 text-neutral-500 hover:text-neutral-200 transition"
        title="Collapse sidebar (⌘B)"
        onClick={props.onCollapse}
      >
        <ChevronLeft size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

function TabButton(props: {
  label: string;
  icon: any;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={props.onClick}
      class={
        "px-3 flex items-center gap-1.5 border-b-2 transition " +
        (props.active
          ? "border-indigo-500 text-neutral-100"
          : "border-transparent text-neutral-500 hover:text-neutral-200")
      }
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}
