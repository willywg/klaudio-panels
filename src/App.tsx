import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { HomeScreen } from "@/components/home-screen";
import { ProjectsSidebar } from "@/components/projects-sidebar";
import { SessionsList, type SessionMeta } from "@/components/sessions-list";
import { TerminalView } from "@/components/terminal-view";
import { TabStrip } from "@/components/tab-strip";
import { SidebarPanel } from "@/components/sidebar-panel";
import { Titlebar } from "@/components/titlebar";
import { FileTree } from "@/components/file-tree/file-tree";
import {
  getLastSessionId,
  setLastSessionId,
} from "@/components/last-session";
import { ProjectsProvider, useProjects } from "@/context/projects";
import { TerminalProvider, useTerminal } from "@/context/terminal";
import { SidebarProvider, useSidebar } from "@/context/sidebar";
import {
  SessionWatcherProvider,
  useSessionWatcher,
} from "@/context/session-watcher";
import { GitProvider, useGit } from "@/context/git";
import { DiffPanelProvider, useDiffPanel } from "@/context/diff-panel";
import { DiffPanel } from "@/components/diff-panel/diff-panel";
import { SplitDivider } from "@/components/diff-panel/split-pane";
import { displayLabel } from "@/lib/session-label";

const AUTO_RESUME_FAIL_WINDOW_MS = 2000;

function Shell() {
  const [activeProjectPath, setActiveProjectPathSignal] = createSignal<
    string | null
  >(localStorage.getItem("projectPath"));
  const [sessionsRefresh, setSessionsRefresh] = createSignal(0);
  const term = useTerminal();
  const projects = useProjects();
  const sidebar = useSidebar();
  const sessionWatcher = useSessionWatcher();
  const git = useGit();
  const diffPanel = useDiffPanel();
  let splitContainerRef!: HTMLDivElement;

  // Remembered active tab per project. Set BEFORE changing activeProjectPath
  // (inside setActiveProjectPath) so it's never wrong when the switch effect
  // reads it.
  const activeByProject = new Map<string, string | null>();
  // Track which projects have already consumed their auto-resume (once per
  // app lifetime — switching away and back doesn't re-trigger).
  const autoResumed = new Set<string>();

  /** Single entry point for changing which project is active. Always save the
   *  current active tab for the OUTGOING project first, so coming back lands
   *  on the right tab. */
  function setActiveProjectPath(next: string | null) {
    const prev = activeProjectPath();
    if (prev === next) return;
    if (prev !== null) {
      activeByProject.set(prev, term.store.activeTabId);
    }
    setActiveProjectPathSignal(next);
  }

  // Persist + touch on active project change.
  createEffect(() => {
    const p = activeProjectPath();
    if (p) {
      localStorage.setItem("projectPath", p);
      projects.touch(p);
    } else {
      localStorage.removeItem("projectPath");
    }
  });

  // On active project change, pick the right tab to show (remembered > first
  // existing > null). If none, consider auto-resume. This is the SOLE place
  // that calls term.setActiveTab as a response to project switch.
  createEffect(
    on(activeProjectPath, (p) => {
      if (!p) {
        term.setActiveTab(null);
        return;
      }
      const tabsInProject = term.store.tabs.filter(
        (t) => t.projectPath === p,
      );
      const remembered = activeByProject.get(p) ?? null;
      let nextActive: string | null = null;
      if (remembered && tabsInProject.some((t) => t.id === remembered)) {
        nextActive = remembered;
      } else if (tabsInProject.length > 0) {
        nextActive = tabsInProject[0].id;
      }
      term.setActiveTab(nextActive);
      if (nextActive === null) maybeAutoResume(p);
    }),
  );

  // Auto-refresh sessions list whenever tabs open/close for the active
  // project. Captures 80% of /rename cases (rename during session, then close
  // tab, reopen -> new title picked up).
  createEffect(
    on(
      () => term.store.tabs.length,
      () => setSessionsRefresh((k) => k + 1),
      { defer: true },
    ),
  );

  // Refresh sessions list when the JSONL watcher sees a rename/summary/new —
  // covers the live-/rename path without manually clicking refresh.
  createEffect(
    on(
      sessionWatcher.metaBump,
      () => setSessionsRefresh((k) => k + 1),
      { defer: true },
    ),
  );

  // Seed recent projects with the project loaded from localStorage on boot.
  onMount(() => {
    const p = activeProjectPath();
    if (p) projects.touch(p);
  });

  // Cmd+B toggles the sidebar, Cmd+Shift+D toggles the diff panel. Listening
  // on window (bubble phase) so xterm.js forwarding the keystroke to the PTY
  // doesn't stop us from acting too.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key === "b") {
        e.preventDefault();
        sidebar.toggleCollapsed();
        return;
      }
      if (mod && e.shiftKey && !e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (activeProjectPath()) diffPanel.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Prime git status + summary for the active project. GitProvider itself
  // subscribes to fs:event:<projectPath> on first ensureFor.
  createEffect(
    on(activeProjectPath, (p) => {
      if (p) void git.ensureFor(p);
    }),
  );

  // Close the diff panel on project switch so it never shows stale content
  // from the previous project. Width (per-project) is still persisted.
  createEffect(
    on(activeProjectPath, () => diffPanel.close(), { defer: true }),
  );

  const projectTabs = createMemo(() => {
    const p = activeProjectPath();
    if (!p) return [];
    return term.store.tabs.filter((t) => t.projectPath === p);
  });

  const openTabsByProject = createMemo(() => {
    const map = new Map<string, number>();
    for (const t of term.store.tabs) {
      map.set(t.projectPath, (map.get(t.projectPath) ?? 0) + 1);
    }
    return map;
  });

  const activeTab = createMemo(() => {
    const id = term.store.activeTabId;
    if (!id) return undefined;
    return term.store.tabs.find((t) => t.id === id);
  });

  // Whenever the user activates a tab manually (TabStrip click) within the
  // active project, remember that as the project's preferred tab.
  createEffect(
    on(
      () => term.store.activeTabId,
      (id) => {
        const p = activeProjectPath();
        if (!p) return;
        const tab = id
          ? term.store.tabs.find((t) => t.id === id)
          : undefined;
        if (tab && tab.projectPath === p) {
          activeByProject.set(p, id);
        }
      },
    ),
  );

  const activeSessionId = () => {
    const a = activeTab();
    if (!a || a.projectPath !== activeProjectPath()) return null;
    return a.sessionId ?? null;
  };

  const openSessionIds = createMemo(() => {
    const p = activeProjectPath();
    const set = new Set<string>();
    if (!p) return set;
    for (const t of term.store.tabs) {
      if (t.projectPath !== p) continue;
      if (t.sessionId && t.status !== "opening") set.add(t.sessionId);
    }
    return set;
  });

  const openingSessionIds = createMemo(() => {
    const p = activeProjectPath();
    const set = new Set<string>();
    if (!p) return set;
    for (const t of term.store.tabs) {
      if (t.projectPath !== p) continue;
      if (t.sessionId && t.status === "opening") set.add(t.sessionId);
    }
    return set;
  });

  const anyTabOpeningForActive = createMemo(() =>
    projectTabs().some((t) => t.status === "opening"),
  );

  // Persist lastSessionId for the active project.
  createEffect(() => {
    const p = activeProjectPath();
    const a = activeTab();
    if (!p || !a || a.projectPath !== p) return;
    if (a.sessionId) setLastSessionId(p, a.sessionId);
  });

  async function openNewTab() {
    const p = activeProjectPath();
    if (!p) return;
    try {
      await term.openTab(p, [], { label: "New session", sessionId: null });
    } catch (err) {
      console.error("openTab(new) failed", err);
    } finally {
      setSessionsRefresh((k) => k + 1);
    }
  }

  async function openResumeTab(
    projectPath: string,
    sessionId: string,
    label: string,
  ) {
    try {
      await term.openTab(projectPath, ["--resume", sessionId], {
        label,
        sessionId,
      });
    } catch (err) {
      console.error("openTab(resume) failed", err);
    } finally {
      setSessionsRefresh((k) => k + 1);
    }
  }

  function handleSelectSession(meta: SessionMeta) {
    const p = activeProjectPath();
    if (!p) return;
    const existing = term.store.tabs.find(
      (t) => t.projectPath === p && t.sessionId === meta.id,
    );
    if (existing) {
      term.setActiveTab(existing.id);
      return;
    }
    void openResumeTab(p, meta.id, displayLabel(meta));
  }

  function handleActivateTab(id: string) {
    term.setActiveTab(id);
  }

  async function handleCloseTab(id: string) {
    await term.closeTab(id);
  }

  function maybeAutoResume(projectPath: string) {
    if (autoResumed.has(projectPath)) return;
    autoResumed.add(projectPath);
    const existing = term.store.tabs.filter(
      (t) => t.projectPath === projectPath,
    );
    if (existing.length > 0) return;
    const lastId = getLastSessionId(projectPath);
    if (!lastId) return;

    // Resolve the real session label (custom-title / summary) before opening
    // the tab, so auto-resumed tabs show the rename, not "session xxxxxxxx".
    void (async () => {
      const spawnedAt = Date.now();
      let label = `session ${lastId.slice(0, 8)}`;
      try {
        const sessions = (await invoke("list_sessions_for_project", {
          projectPath,
        })) as SessionMeta[];
        const meta = sessions.find((s) => s.id === lastId);
        if (!meta) {
          console.info(
            `auto-resume target ${lastId} no longer exists in ${projectPath}. Clearing lastSessionId.`,
          );
          setLastSessionId(projectPath, null);
          return;
        }
        label = displayLabel(meta);
      } catch (err) {
        console.warn("list_sessions_for_project failed during auto-resume", err);
      }

      try {
        const tabId = await term.openTab(
          projectPath,
          ["--resume", lastId],
          { label, sessionId: lastId },
        );
        const detach = term.onExit(tabId, (code) => {
          const elapsed = Date.now() - spawnedAt;
          if (elapsed < AUTO_RESUME_FAIL_WINDOW_MS && code !== 0) {
            console.info(
              `auto-resume failed for ${lastId} (exit ${code} after ${elapsed}ms). Clearing lastSessionId.`,
            );
            setLastSessionId(projectPath, null);
            void term.closeTab(tabId);
          }
          detach();
        });
      } catch (err) {
        console.warn("auto-resume openTab threw", err);
        setLastSessionId(projectPath, null);
      } finally {
        setSessionsRefresh((k) => k + 1);
      }
    })();
  }

  function handleAddProject(path: string) {
    projects.touch(path);
    setActiveProjectPath(path);
  }

  async function handleCloseProject(path: string) {
    // Kill all PTYs for the project.
    const ids = term.store.tabs
      .filter((t) => t.projectPath === path)
      .map((t) => t.id);
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await term.closeTab(id);
    }
    // Pivot away if it was active, BEFORE unpin, so the active-tab effect
    // has a valid target.
    if (activeProjectPath() === path) {
      setActiveProjectPath(null);
    }
    activeByProject.delete(path);
    autoResumed.delete(path);
    // Don't clear lastSessionId — keep it so next time the user re-pins from
    // Home, auto-resume picks up where they left off.
    projects.unpin(path);
  }

  function handlePickFromHome(path: string) {
    projects.touch(path);
    setActiveProjectPath(path);
  }

  function goHome() {
    setActiveProjectPath(null);
  }

  return (
    <div class="h-screen w-screen flex flex-col bg-neutral-950 text-neutral-200 overflow-hidden">
      <Titlebar
        hasActiveProject={activeProjectPath() !== null}
        activeProjectPath={activeProjectPath()}
      />
      <main class="flex-1 flex min-h-0 overflow-hidden">
      <ProjectsSidebar
        activePath={activeProjectPath()}
        onActivate={setActiveProjectPath}
        onAdd={handleAddProject}
        onGoHome={goHome}
        onCloseProject={(path) => void handleCloseProject(path)}
        openTabsByProject={openTabsByProject()}
      />

      <Show
        when={activeProjectPath()}
        fallback={<HomeScreen onPick={handlePickFromHome} />}
      >
        <div class="flex-1 flex min-h-0 overflow-hidden">
          <SidebarPanel
            projectPath={activeProjectPath()!}
            sessionsContent={
              <SessionsList
                projectPath={activeProjectPath()!}
                activeSessionId={activeSessionId()}
                openSessionIds={openSessionIds()}
                openingSessionIds={openingSessionIds()}
                onNew={() => void openNewTab()}
                onSelect={handleSelectSession}
                onRefresh={() => setSessionsRefresh((k) => k + 1)}
                refreshKey={sessionsRefresh()}
              />
            }
            filesContent={<FileTree projectPath={activeProjectPath()!} />}
          />

          <div
            ref={splitContainerRef}
            class="flex-1 flex min-w-0 min-h-0 overflow-hidden"
          >
            <section class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
              <TabStrip
                tabs={projectTabs()}
                activeTabId={term.store.activeTabId}
                onActivate={handleActivateTab}
                onClose={(id) => void handleCloseTab(id)}
                onNew={() => void openNewTab()}
                canOpenNew={!anyTabOpeningForActive()}
              />
              <div class="relative flex-1 min-h-0 overflow-hidden">
                <For each={term.store.tabs}>
                  {(tab) => {
                    const isActive = () => tab.id === term.store.activeTabId;
                    const isForActiveProject = () =>
                      tab.projectPath === activeProjectPath();
                    const visible = () => isActive() && isForActiveProject();
                    return (
                      <div
                        class="absolute inset-0 flex flex-col"
                        style={{
                          visibility: visible() ? "visible" : "hidden",
                          "pointer-events": visible() ? "auto" : "none",
                          "z-index": visible() ? 1 : 0,
                        }}
                      >
                        <Show
                          when={tab.status !== "opening"}
                          fallback={<LoadingPanel label={tab.label} />}
                        >
                          <TerminalView id={tab.id} active={visible()} />
                        </Show>
                      </div>
                    );
                  }}
                </For>
                <Show when={projectTabs().length === 0}>
                  <div class="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm">
                    Pick a session or start a new one.
                  </div>
                </Show>
              </div>
            </section>
            <Show when={diffPanel.isOpen() && activeProjectPath()}>
              {(p) => (
                <>
                  <SplitDivider
                    width={diffPanel.widthFor(p())}
                    onResize={(w) => diffPanel.setWidth(p(), w)}
                    onResizeEnd={(w) => diffPanel.setWidth(p(), w)}
                    getParentRect={() =>
                      splitContainerRef.getBoundingClientRect()
                    }
                  />
                  <div
                    class="shrink-0 min-h-0 flex flex-col overflow-hidden"
                    style={{ width: `${diffPanel.widthFor(p())}px` }}
                  >
                    <DiffPanel projectPath={p()} />
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>
      </Show>
      </main>
    </div>
  );
}

function LoadingPanel(props: { label?: string }) {
  return (
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="flex flex-col items-center gap-3 text-neutral-400 text-sm">
        <div class="flex items-center gap-3">
          <div class="w-4 h-4 border-2 border-neutral-700 border-t-indigo-500 rounded-full animate-spin" />
          <span>Starting Claude Code…</span>
        </div>
        <Show when={props.label}>
          <span class="text-[11px] text-neutral-600 font-mono truncate max-w-[300px]">
            {props.label}
          </span>
        </Show>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ProjectsProvider>
      <SidebarProvider>
        <GitProvider>
          <DiffPanelProvider>
            <TerminalProvider>
              <SessionWatcherProvider>
                <Shell />
              </SessionWatcherProvider>
            </TerminalProvider>
          </DiffPanelProvider>
        </GitProvider>
      </SidebarProvider>
    </ProjectsProvider>
  );
}
