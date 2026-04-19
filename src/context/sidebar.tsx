import {
  createContext,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";
import {
  getActiveTab,
  getCollapsed,
  setActiveTab as persistActiveTab,
  setCollapsed as persistCollapsed,
  type SidebarTab,
} from "@/lib/sidebar-prefs";

function makeSidebarContext() {
  const [collapsed, setCollapsedSignal] = createSignal<boolean>(getCollapsed());

  // Per-project active tab lives in a Map so switching projects doesn't reset
  // or blow away any other project's selection.
  const tabByProject = new Map<string, SidebarTab>();
  const [tabBump, setTabBump] = createSignal(0);

  function activeTab(projectPath: string): SidebarTab {
    if (!tabByProject.has(projectPath)) {
      tabByProject.set(projectPath, getActiveTab(projectPath));
    }
    void tabBump(); // subscribe to the signal so reactive contexts re-run
    return tabByProject.get(projectPath)!;
  }

  function setTab(projectPath: string, tab: SidebarTab) {
    tabByProject.set(projectPath, tab);
    persistActiveTab(projectPath, tab);
    setTabBump((k) => k + 1);
  }

  function toggleCollapsed() {
    setCollapsedSignal((v) => {
      const next = !v;
      persistCollapsed(next);
      return next;
    });
  }

  function setCollapsed(v: boolean) {
    setCollapsedSignal(v);
    persistCollapsed(v);
  }

  return {
    activeTab,
    setTab,
    collapsed,
    toggleCollapsed,
    setCollapsed,
  };
}

const Ctx = createContext<ReturnType<typeof makeSidebarContext>>();

export function SidebarProvider(props: ParentProps) {
  const ctx = makeSidebarContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useSidebar() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSidebar outside SidebarProvider");
  return v;
}
