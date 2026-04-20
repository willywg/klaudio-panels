import {
  createContext,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  getDiffPanelOpen,
  getDiffPanelWidth,
  setDiffPanelOpen,
  setDiffPanelWidth,
} from "@/lib/diff-panel-prefs";

const DEFAULT_WIDTH = 640;

export type DiffStyle = "unified" | "split";

export type PanelTab =
  | { kind: "diff" }
  | { kind: "file"; path: string; line?: number; openedAt: number };

export function tabKey(t: PanelTab): string {
  return t.kind === "diff" ? "diff" : `file:${t.path}`;
}

type ProjectPanelState = {
  tabs: PanelTab[];
  activeKey: string;
};

function freshState(): ProjectPanelState {
  return { tabs: [{ kind: "diff" }], activeKey: "diff" };
}

function makeDiffPanelContext() {
  const [open, setOpen] = createSignal<boolean>(getDiffPanelOpen());
  /** Set of rel paths that the user has explicitly expanded. Default is
   *  COLLAPSED so opening the panel against 50 changed files doesn't render
   *  50 Shiki/FileDiff instances at once. */
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [focused, setFocused] = createSignal<string | null>(null);
  const [diffStyle, setDiffStyleSignal] = createSignal<DiffStyle>("unified");
  const widthByProject = new Map<string, number>();
  const [widthBump, setWidthBump] = createSignal(0);

  /** Per-project panel tabs. Keyed by projectPath. */
  const [panels, setPanels] = createStore<Record<string, ProjectPanelState>>({});

  function ensureProject(projectPath: string) {
    if (!panels[projectPath]) {
      setPanels(projectPath, freshState());
    }
  }

  function tabsFor(projectPath: string): PanelTab[] {
    ensureProject(projectPath);
    return panels[projectPath].tabs;
  }

  function activeKeyFor(projectPath: string): string {
    ensureProject(projectPath);
    return panels[projectPath].activeKey;
  }

  function setActiveTab(projectPath: string, key: string) {
    ensureProject(projectPath);
    setPanels(projectPath, "activeKey", key);
  }

  function openFile(projectPath: string, rel: string, line?: number) {
    ensureProject(projectPath);
    const key = `file:${rel}`;
    const existing = panels[projectPath].tabs.find((t) => tabKey(t) === key);
    if (!existing) {
      setPanels(
        projectPath,
        produce((state: ProjectPanelState) => {
          state.tabs.push({ kind: "file", path: rel, line, openedAt: Date.now() });
          state.activeKey = key;
        }),
      );
    } else {
      // If user asks to re-open with a new line, update it to drive scroll.
      if (line !== undefined && existing.kind === "file") {
        setPanels(
          projectPath,
          produce((state: ProjectPanelState) => {
            const t = state.tabs.find((x) => tabKey(x) === key);
            if (t && t.kind === "file") t.line = line;
            state.activeKey = key;
          }),
        );
      } else {
        setPanels(projectPath, "activeKey", key);
      }
    }
    if (!open()) {
      setOpen(true);
      setDiffPanelOpen(true);
    }
  }

  function closeTab(projectPath: string, key: string) {
    ensureProject(projectPath);
    if (key === "diff") return;
    setPanels(
      projectPath,
      produce((state: ProjectPanelState) => {
        const idx = state.tabs.findIndex((t) => tabKey(t) === key);
        if (idx === -1) return;
        state.tabs.splice(idx, 1);
        if (state.activeKey === key) {
          const next = state.tabs[Math.max(0, idx - 1)];
          state.activeKey = next ? tabKey(next) : "diff";
        }
      }),
    );
  }

  function closeActiveTab(projectPath: string) {
    ensureProject(projectPath);
    const key = panels[projectPath].activeKey;
    if (key !== "diff") closeTab(projectPath, key);
  }

  function clearProject(projectPath: string) {
    setPanels(projectPath, freshState());
  }

  function widthFor(projectPath: string): number {
    if (!widthByProject.has(projectPath)) {
      const stored = getDiffPanelWidth(projectPath);
      widthByProject.set(projectPath, stored ?? DEFAULT_WIDTH);
    }
    void widthBump();
    return widthByProject.get(projectPath)!;
  }

  function setWidth(projectPath: string, px: number) {
    widthByProject.set(projectPath, px);
    setDiffPanelWidth(projectPath, px);
    setWidthBump((k) => k + 1);
  }

  function isExpanded(rel: string): boolean {
    return expanded().has(rel);
  }

  function toggleFile(rel: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  /** Expand a changed file in the Git-changes accordion AND request the panel
   *  scroll to it. Also forces the Git-changes tab active. */
  function focusFile(projectPath: string, rel: string) {
    setExpanded((prev) => {
      if (prev.has(rel)) return prev;
      const next = new Set(prev);
      next.add(rel);
      return next;
    });
    setFocused(rel);
    ensureProject(projectPath);
    setPanels(projectPath, "activeKey", "diff");
    if (!open()) {
      setOpen(true);
      setDiffPanelOpen(true);
    }
  }

  function clearFocus() {
    setFocused(null);
  }

  function expandAll(rels: string[]) {
    setExpanded(new Set(rels));
  }

  function collapseAll() {
    setExpanded(new Set<string>());
  }

  function openPanel() {
    if (!open()) {
      setOpen(true);
      setDiffPanelOpen(true);
    }
  }

  function close() {
    setOpen(false);
    setDiffPanelOpen(false);
  }

  function toggle() {
    if (open()) close();
    else openPanel();
  }

  function setDiffStyle(s: DiffStyle) {
    setDiffStyleSignal(s);
  }

  return {
    isOpen: open,
    isExpanded,
    focused,
    clearFocus,
    toggleFile,
    focusFile,
    expandAll,
    collapseAll,
    openPanel,
    close,
    toggle,
    diffStyle,
    setDiffStyle,
    widthFor,
    setWidth,
    // Tabs
    tabsFor,
    activeKeyFor,
    setActiveTab,
    openFile,
    closeTab,
    closeActiveTab,
    clearProject,
  };
}

const Ctx = createContext<ReturnType<typeof makeDiffPanelContext>>();

export function DiffPanelProvider(props: ParentProps) {
  const ctx = makeDiffPanelContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useDiffPanel() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDiffPanel outside DiffPanelProvider");
  return v;
}
