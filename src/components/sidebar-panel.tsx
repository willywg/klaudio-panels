import { Show, type JSX } from "solid-js";
import { projectLabel } from "@/lib/recent-projects";
import { useSidebar } from "@/context/sidebar";
import { SidebarTabs } from "./sidebar-tabs";

type Props = {
  projectPath: string;
  sessionsContent: JSX.Element;
  filesContent: JSX.Element;
};

/** Drag-resizable aside when expanded; renders nothing when collapsed. Width
 *  is per-project (default 280px, persisted in localStorage). Toggle lives in
 *  the titlebar via <TitlebarToggle>. Cmd+B toggles from anywhere. Active tab
 *  is per-project. */
export function SidebarPanel(props: Props) {
  const sidebar = useSidebar();

  return (
    <Show when={!sidebar.collapsed()}>
      <aside
        class="shrink-0 border-r border-neutral-800 flex flex-col min-h-0 overflow-hidden bg-neutral-950"
        style={{ width: `${sidebar.widthFor(props.projectPath)}px` }}
      >
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
