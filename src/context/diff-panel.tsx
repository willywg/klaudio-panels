import {
  createContext,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";
import {
  getDiffPanelOpen,
  getDiffPanelWidth,
  setDiffPanelOpen,
  setDiffPanelWidth,
} from "@/lib/diff-panel-prefs";

const DEFAULT_WIDTH = 640;

export type DiffStyle = "unified" | "split";

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

  /** Expand a file AND request the panel scroll to it (cleared after one
   *  render by the consumer). */
  function focusFile(rel: string) {
    setExpanded((prev) => {
      if (prev.has(rel)) return prev;
      const next = new Set(prev);
      next.add(rel);
      return next;
    });
    setFocused(rel);
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
