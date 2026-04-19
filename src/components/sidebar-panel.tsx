import { Show, type JSX } from "solid-js";
import { projectLabel } from "@/lib/recent-projects";
import { useSidebar } from "@/context/sidebar";
import { SidebarTabs } from "./sidebar-tabs";
import { SidebarRail } from "./sidebar-rail";
import type { SidebarTab } from "@/lib/sidebar-prefs";

type Props = {
  projectPath: string;
  sessionsContent: JSX.Element;
  filesContent: JSX.Element;
};

/** 280px aside when expanded; 36px rail when collapsed. Cmd+B toggles from
 *  App-level shortcut. Active tab is per-project. */
export function SidebarPanel(props: Props) {
  const sidebar = useSidebar();

  function expandInto(tab: SidebarTab) {
    sidebar.setTab(props.projectPath, tab);
    sidebar.setCollapsed(false);
  }

  return (
    <Show
      when={!sidebar.collapsed()}
      fallback={
        <SidebarRail
          onExpand={() => sidebar.setCollapsed(false)}
          onExpandInto={expandInto}
        />
      }
    >
      <aside class="w-[280px] shrink-0 border-r border-neutral-800 flex flex-col min-h-0 overflow-hidden bg-neutral-950">
        <div class="px-3 py-2 border-b border-neutral-800">
          <div class="text-[10px] uppercase tracking-wider text-neutral-500">
            Project
          </div>
          <div
            class="text-xs text-neutral-200 truncate font-medium"
            title={props.projectPath}
          >
            {projectLabel(props.projectPath)}
          </div>
          <div
            class="text-[10px] text-neutral-500 truncate font-mono"
            title={props.projectPath}
          >
            {props.projectPath}
          </div>
        </div>
        <SidebarTabs
          active={sidebar.activeTab(props.projectPath)}
          onChange={(t) => sidebar.setTab(props.projectPath, t)}
          onCollapse={() => sidebar.setCollapsed(true)}
        />
        <div class="flex-1 min-h-0 overflow-hidden">
          <Show
            when={sidebar.activeTab(props.projectPath) === "sessions"}
            fallback={props.filesContent}
          >
            {props.sessionsContent}
          </Show>
        </div>
      </aside>
    </Show>
  );
}
