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
  | { kind: "file"; path: string; line?: number; openedAt: number }
  | {
      kind: "editor";
      editorId: string;
      path: string;
      ptyId: string;
      openedAt: number;
    }
  | { kind: "edit"; path: string; openedAt: number };

export function tabKey(t: PanelTab): string {
  if (t.kind === "diff") return "diff";
  if (t.kind === "file") return `file:${t.path}`;
  if (t.kind === "edit") return `edit:${t.path}`;
  return `editor:${t.editorId}:${t.path}`;
}

/** Async, cancellable close decision. EditorTab registers one of these so it
 *  can show a "Save / Discard / Cancel" prompt before the tab is spliced.
 *  Returning "keep" aborts the close. Without a registered guard, closeTab
 *  proceeds immediately as before. */
export type CloseGuard = (tab: PanelTab) => Promise<"close" | "keep">;

type ProjectPanelState = {
  tabs: PanelTab[];
  activeKey: string;
};

function freshState(): ProjectPanelState {
  return { tabs: [{ kind: "diff" }], activeKey: "diff" };
}

function makeDiffPanelContext() {
  // Open/closed state is per-project. Stored as a reactive Record so any read
  // of `isOpen(path)` subscribes to changes for that path, and persisted
  // under `diffPanelOpen:<path>`. Solves the "close in A also closes B"
  // cross-talk of the previous single-signal design.
  const [openMap, setOpenMap] = createSignal<Record<string, boolean>>({});

  function isOpen(projectPath: string): boolean {
    const cached = openMap()[projectPath];
    if (cached !== undefined) return cached;
    const initial = getDiffPanelOpen(projectPath);
    setOpenMap((m) => ({ ...m, [projectPath]: initial }));
    return initial;
  }

  function writeOpen(projectPath: string, value: boolean) {
    setDiffPanelOpen(projectPath, value);
    setOpenMap((m) => ({ ...m, [projectPath]: value }));
  }
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
    if (!isOpen(projectPath)) writeOpen(projectPath, true);
  }

  /** Fire-and-forget hook (e.g. editor-pty SIGHUP). Runs AFTER the close
   *  guard resolves "close", and BEFORE the tab is spliced from state.
   *  Cannot cancel — use registerCloseGuard for that. */
  type CloseHook = (tab: PanelTab) => void;
  const closeHooks = new Set<CloseHook>();

  function onBeforeClose(hook: CloseHook): () => void {
    closeHooks.add(hook);
    return () => closeHooks.delete(hook);
  }

  /** Cancellable close guards keyed by tabKey. The EditorTab registers one
   *  on mount, unregisters on cleanup. */
  const closeGuards = new Map<string, CloseGuard>();

  function registerCloseGuard(key: string, guard: CloseGuard): () => void {
    closeGuards.set(key, guard);
    return () => {
      if (closeGuards.get(key) === guard) closeGuards.delete(key);
    };
  }

  function spliceTab(projectPath: string, key: string) {
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

  /** Returns `{ kept: true }` when a registered guard cancelled the close,
   *  `{ kept: false }` when the tab was successfully spliced (or was a no-op
   *  for the protected "diff" tab / a missing key). */
  async function closeTab(
    projectPath: string,
    key: string,
  ): Promise<{ kept: boolean }> {
    ensureProject(projectPath);
    if (key === "diff") return { kept: false };
    const tab = panels[projectPath].tabs.find((t) => tabKey(t) === key);
    if (!tab) return { kept: false };
    const guard = closeGuards.get(key);
    if (guard) {
      const decision = await guard(tab);
      if (decision === "keep") return { kept: true };
    }
    for (const h of closeHooks) h(tab);
    spliceTab(projectPath, key);
    return { kept: false };
  }

  async function closeActiveTab(
    projectPath: string,
  ): Promise<{ kept: boolean }> {
    ensureProject(projectPath);
    const key = panels[projectPath].activeKey;
    if (key === "diff") return { kept: false };
    return closeTab(projectPath, key);
  }

  /** Clears every closable tab in the project, awaiting each guard in
   *  sequence. Returns the count of tabs the user opted to keep — callers
   *  use this to abort their own teardown (e.g. project close). When `kept`
   *  is non-zero the kept tabs remain in their original order; everything
   *  else has been spliced out. */
  async function clearProject(
    projectPath: string,
  ): Promise<{ kept: number }> {
    const existing = panels[projectPath];
    if (!existing) {
      setPanels(projectPath, freshState());
      return { kept: 0 };
    }
    const keys = existing.tabs
      .map((t) => tabKey(t))
      .filter((k) => k !== "diff");
    let kept = 0;
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      const r = await closeTab(projectPath, key);
      if (r.kept) kept += 1;
    }
    if (kept === 0) {
      // All tabs gone — reset to a fresh diff-only state. (closeTab already
      // spliced them; this is just the activeKey reset.)
      setPanels(projectPath, freshState());
    }
    return { kept };
  }

  function findEditTabKey(projectPath: string, path: string): string | null {
    ensureProject(projectPath);
    const key = `edit:${path}`;
    return panels[projectPath].tabs.some((t) => tabKey(t) === key) ? key : null;
  }

  function openEdit(projectPath: string, rel: string) {
    ensureProject(projectPath);
    const key = `edit:${rel}`;
    const existing = panels[projectPath].tabs.find((t) => tabKey(t) === key);
    if (!existing) {
      setPanels(
        projectPath,
        produce((state: ProjectPanelState) => {
          state.tabs.push({ kind: "edit", path: rel, openedAt: Date.now() });
          state.activeKey = key;
        }),
      );
    } else {
      setPanels(projectPath, "activeKey", key);
    }
    if (!isOpen(projectPath)) writeOpen(projectPath, true);
  }

  /** Look up an existing editor tab for `(editorId, path)`. Used to dedup
   *  before spawning a second PTY against the same file. */
  function findEditorTabKey(
    projectPath: string,
    editorId: string,
    path: string,
  ): string | null {
    ensureProject(projectPath);
    const key = `editor:${editorId}:${path}`;
    return panels[projectPath].tabs.some((t) => tabKey(t) === key) ? key : null;
  }

  function addEditorTab(
    projectPath: string,
    editorId: string,
    path: string,
    ptyId: string,
  ) {
    ensureProject(projectPath);
    const key = `editor:${editorId}:${path}`;
    setPanels(
      projectPath,
      produce((state: ProjectPanelState) => {
        state.tabs.push({
          kind: "editor",
          editorId,
          path,
          ptyId,
          openedAt: Date.now(),
        });
        state.activeKey = key;
      }),
    );
    if (!isOpen(projectPath)) writeOpen(projectPath, true);
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
    if (!isOpen(projectPath)) writeOpen(projectPath, true);
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

  function openPanel(projectPath: string) {
    if (!isOpen(projectPath)) writeOpen(projectPath, true);
  }

  function close(projectPath: string) {
    writeOpen(projectPath, false);
  }

  function toggle(projectPath: string) {
    if (isOpen(projectPath)) close(projectPath);
    else openPanel(projectPath);
  }

  function setDiffStyle(s: DiffStyle) {
    setDiffStyleSignal(s);
  }

  return {
    isOpen,
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
    findEditorTabKey,
    addEditorTab,
    openEdit,
    findEditTabKey,
    onBeforeClose,
    registerCloseGuard,
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
