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
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { buildDropPayload, findDropTarget } from "@/lib/os-drop";
import {
  INTERNAL_DROP_EVENT,
  type InternalDropDetail,
} from "@/lib/internal-drag";
import { HomeScreen } from "@/components/home-screen";
import { ProjectsSidebar } from "@/components/projects-sidebar";
import { SessionsList, type SessionMeta } from "@/components/sessions-list";
import { TerminalView } from "@/components/terminal-view";
import { TabStrip } from "@/components/tab-strip";
import { SidebarPanel } from "@/components/sidebar-panel";
import { Titlebar } from "@/components/titlebar";
import { NotificationToastStack } from "@/components/notification-toast";
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
import { EditBuffersProvider } from "@/context/edit-buffers";
import { OpenInProvider } from "@/context/open-in";
import { EditorPtyProvider, useEditorPty } from "@/context/editor-pty";
import { ShellPtyProvider, useShellPty } from "@/context/shell-pty";
import { ShellPanelProvider, useShellPanel } from "@/context/shell-panel";
import {
  CommandPaletteProvider,
  useCommandPalette,
} from "@/context/command-palette";
import { CommandPalette } from "@/components/command-palette";
import { RevealProvider, useReveal } from "@/context/reveal";
import {
  NotificationsProvider,
  useNotifications,
} from "@/context/notifications";
import { installGlobalErrorForwarding } from "@/lib/debug-log";
import { DiffPanel } from "@/components/diff-panel/diff-panel";
import { SplitDivider } from "@/components/diff-panel/split-pane";
import {
  CENTER_MIN,
  DIFF_MIN,
  SIDEBAR_MIN,
  computePanelLayout,
} from "@/lib/panel-layout";
import { ShellTerminalPanel } from "@/components/shell-terminal/shell-terminal-panel";
import { Toaster } from "@/components/toaster";
import { requestScrollToBottom } from "@/lib/terminal-scroll-bus";
import { displayLabel } from "@/lib/session-label";

const AUTO_RESUME_FAIL_WINDOW_MS = 2000;

function relPathInside(base: string, full: string): string | null {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  if (full === b) return null;
  const prefix = b + "/";
  return full.startsWith(prefix) ? full.slice(prefix.length) : null;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function installSuccessMessage(where: string): string {
  const dir = dirname(where);
  const inPrimary = where.startsWith("/usr/local/bin");
  const header = `Installed at ${where}.`;
  const reloadHint =
    "Open a new terminal window to pick it up. In a still-open shell, run `rehash` (zsh) or `hash -r` (bash).";
  const pathHint = inPrimary
    ? `If klaudio is still "not found", /usr/local/bin may be missing from your PATH — common in iTerm profiles that aren't set to "Login shell". Fix the profile, or add:\n\n  export PATH="/usr/local/bin:$PATH"\n\nto ~/.zshrc.`
    : `Make sure ${dir} is on your PATH. Add this to ~/.zshrc (or ~/.bashrc) if needed:\n\n  export PATH="${dir}:$PATH"`;
  return `${header}\n\n${reloadHint}\n\n${pathHint}`;
}

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
  const editorPty = useEditorPty();
  const shellPty = useShellPty();
  const shellPanel = useShellPanel();
  const commandPalette = useCommandPalette();
  const reveal = useReveal();
  const notifications = useNotifications();
  let splitContainerRef!: HTMLDivElement;
  let sidebarRowRef!: HTMLDivElement;

  // Live width of the outer flex row that hosts sidebar + center + diff
  // panel. Drives the proportional shrink logic below. Updated by a
  // ResizeObserver installed onMount; zero until first measurement so the
  // contexts' effectiveWidthFor() fallback to stored width during the
  // first render tick.
  const [rowWidth, setRowWidth] = createSignal(0);

  const sidebarVisible = () =>
    !sidebar.collapsed() && activeProjectPath() !== null;

  // Combined layout: we compute BOTH panels' effective widths together
  // because the interaction between them matters. Each panel capped
  // independently at row*0.5 lets them both reach 50%, leaving nothing
  // for the center. `computePanelLayout` does the joint clamp and the
  // auto-hide decision in one pure pass.
  const panelLayout = createMemo(() => {
    const p = activeProjectPath();
    return computePanelLayout({
      rowWidth: rowWidth(),
      sidebarVisible: sidebarVisible(),
      diffOpen: p !== null && diffPanel.isOpen(p),
      sidebarStored: p !== null ? sidebar.widthFor(p) : 0,
      diffStored: p !== null ? diffPanel.widthFor(p) : 0,
    });
  });

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

  // Persist + touch on active project change. Also clear the unread
  // pulse — landing on a project is the user's "I'm here now" signal,
  // even if the active tab inside it isn't the one Claude finished in.
  createEffect(() => {
    const p = activeProjectPath();
    if (p) {
      localStorage.setItem("projectPath", p);
      projects.touch(p);
      notifications.markRead(p);
    } else {
      localStorage.removeItem("projectPath");
    }
  });

  // Hook the notifications context up to the live store. The resolver
  // bridges three concerns the context can't see on its own: which
  // project the user is currently looking at (suppresses the amber
  // ring when alerts come from where they already are), how to map a
  // cwd reported by the warp plugin to one of our open projects (the
  // plugin's cwd can be a subdir of the root), and how to switch
  // projects when a toast is clicked.
  notifications.setProjectResolver({
    isActiveProject: (projectPath) => projectPath === activeProjectPath(),
    resolveOpenProject: (cwd) => {
      if (!cwd) return null;
      const norm = cwd.replace(/\/+$/, "");
      let best: string | null = null;
      for (const t of term.store.tabs) {
        const p = t.projectPath.replace(/\/+$/, "");
        if (norm === p || norm.startsWith(p + "/")) {
          if (!best || p.length > best.length) best = p;
        }
      }
      return best;
    },
    activateProject: (projectPath) => setActiveProjectPath(projectPath),
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

  // Track the outer flex row's width so the sidebar and diff panel can
  // clamp their rendered widths on window resize without mutating stored
  // preferences. ResizeObserver's callback is already rAF-aligned by the
  // browser — no debounce needed.
  onMount(() => {
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setRowWidth(e.contentRect.width);
    });
    ro.observe(sidebarRowRef);
    onCleanup(() => ro.disconnect());
  });

  // Seed recent projects with the project loaded from localStorage on boot.
  onMount(() => {
    const p = activeProjectPath();
    if (p) projects.touch(p);
  });

  // When a PanelTab is about to be spliced (close button, Cmd+W, "Close other
  // tabs", project close via clearProject), kill the editor PTY. Without this
  // the child process stays alive headless and leaks kqueue fds.
  onMount(() => {
    const dispose = diffPanel.onBeforeClose((tab) => {
      if (tab.kind === "editor") {
        void editorPty.killEditor(tab.ptyId);
      }
    });
    onCleanup(dispose);
  });

  // Reveal-in-tree: when diffPanel.openFile fires (Cmd+K palette, etc.), the
  // <FileTree> may not be mounted yet because the sidebar is on Sessions.
  // Switch the sidebar to Files first — that mounts <FileTree>, which then
  // picks up the same pending reveal via its own effect and runs the walk +
  // scroll + highlight. This effect lives in Shell (always mounted) so the
  // tab-switch happens regardless of the current sidebar state.
  let lastHandledTabSwitchId = 0;
  createEffect(() => {
    const r = reveal.pending();
    if (!r) return;
    if (r.id <= lastHandledTabSwitchId) return;
    lastHandledTabSwitchId = r.id;
    if (sidebar.activeTab(r.projectPath) !== "files") {
      sidebar.setTab(r.projectPath, "files");
    }
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
      // Cmd+K opens the command palette (Sessions + Files quick search).
      // Toggle so a second press from inside the palette also closes it,
      // mirroring how Cmd+B and Cmd+J behave.
      if (mod && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        commandPalette.toggle();
        return;
      }
      if (mod && e.shiftKey && !e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        const p = activeProjectPath();
        if (p) diffPanel.toggle(p);
      }
      // Cmd+W closes the active file-preview tab in the diff panel. Only
      // when the panel is open and a file tab is active — otherwise Cmd+W
      // is left alone for future tab-close wiring.
      if (mod && !e.shiftKey && !e.altKey && e.key === "w") {
        const p = activeProjectPath();
        if (!p || !diffPanel.isOpen(p)) return;
        const key = diffPanel.activeKeyFor(p);
        if (key === "diff") return;
        e.preventDefault();
        void diffPanel.closeActiveTab(p);
      }
      // Cmd+J toggles the bottom shell terminal. WebKit uses the same combo
      // for "Jump to Downloads" when nothing is focused — preventDefault
      // stops it stealing the shortcut.
      if (mod && !e.shiftKey && !e.altKey && (e.key === "j" || e.key === "J")) {
        const p = activeProjectPath();
        if (!p) return;
        e.preventDefault();
        shellPanel.toggleFor(p);
      }
      // Cmd+T opens a new tab, contextual to where focus is: if the user
      // is typing inside the shell dock, add a shell tab; otherwise add a
      // new Claude session tab. Using `activeElement` (not `e.target`)
      // because the key event on xterm's hidden textarea still reports
      // the textarea as activeElement, which lets `closest` walk up.
      if (mod && !e.shiftKey && !e.altKey && (e.key === "t" || e.key === "T")) {
        const p = activeProjectPath();
        if (!p) return;
        e.preventDefault();
        const inShellDock =
          document.activeElement instanceof Element &&
          document.activeElement.closest("[data-shell-dock]") !== null;
        if (inShellDock) {
          void shellPty.openTab(p);
        } else {
          void openNewTab();
        }
        return;
      }
      // Cmd+Down: scroll the terminal under the user's focus to its tail.
      // Same shell-dock disambiguation as Cmd+T — focus inside the dock hits
      // the active shell PTY, otherwise the active Claude tab. Companion to
      // the floating ScrollToBottomButton each terminal renders.
      if (mod && !e.shiftKey && !e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        const inShellDock =
          document.activeElement instanceof Element &&
          document.activeElement.closest("[data-shell-dock]") !== null;
        if (inShellDock) {
          const p = activeProjectPath();
          if (p) requestScrollToBottom(shellPty.activeForProject(p));
        } else {
          requestScrollToBottom(term.store.activeTabId);
        }
        return;
      }
      // Cmd+1..8 jumps to the Nth pinned project; Cmd+9 goes to the last
      // one (same convention as browser tabs, iTerm, Slack). The index is
      // the sidebar's visual order — `projects.pinned` is exactly what
      // ProjectsSidebar renders.
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const pinned = projects.pinned;
        if (pinned.length === 0) return;
        const n = Number(e.key);
        const target = n === 9 ? pinned[pinned.length - 1] : pinned[n - 1];
        if (!target) return;
        e.preventDefault();
        setActiveProjectPath(target.path);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // File drops from two independent sources:
  //   (a) Finder / other apps — Tauri captures at the NSView layer
  //       (needs `dragDropEnabled: true`) and hands us absolute paths.
  //   (b) Our own file tree — pointer-based custom drag dispatches a
  //       CustomEvent on `window` with the resolved pty target.
  // The HTML5 drag-drop pipeline no longer works once the NSView hook
  // is on (macOS intercepts all drags regardless of MIME), which is
  // why the file tree runs its own pointer flow in tree-node.tsx.
  onMount(() => {
    const encoder = new TextEncoder();
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const p = activeProjectPath();
        if (!p) return;
        const target = findDropTarget(event.payload.position);
        if (!target) return;
        const payload = buildDropPayload(event.payload.paths, p);
        if (!payload) return;
        const bytes = encoder.encode(payload);
        if (target.kind === "claude") {
          void term.write(target.ptyId, bytes);
        } else {
          void shellPty.write(target.ptyId, bytes);
        }
      })
      .then((u) => {
        unlisten = u;
      })
      .catch((err) => console.warn("drag-drop listen failed", err));

    const onInternalDrop = (e: Event) => {
      const detail = (e as CustomEvent<InternalDropDetail>).detail;
      const p = activeProjectPath();
      if (!p || !detail) return;
      const payload = buildDropPayload([detail.path], p);
      if (!payload) return;
      const bytes = encoder.encode(payload);
      if (detail.ptyKind === "claude") {
        void term.write(detail.ptyId, bytes);
      } else {
        void shellPty.write(detail.ptyId, bytes);
      }
    };
    window.addEventListener(INTERNAL_DROP_EVENT, onInternalDrop);

    onCleanup(() => {
      unlisten?.();
      window.removeEventListener(INTERNAL_DROP_EVENT, onInternalDrop);
    });
  });

  // Prime git status + summary for the active project. GitProvider itself
  // subscribes to the `fs-event` channel on first ensureFor and filters
  // by project_path.
  createEffect(
    on(activeProjectPath, (p) => {
      if (p) void git.ensureFor(p);
    }),
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

  // Every project that needs its ShellTerminalPanel mounted right now:
  // any project with live shell PTYs (so switching away and back preserves
  // xterm scrollback), plus the active project if its panel flag is on
  // (covers the first-open case before the first tab has spawned).
  const shellMountedProjects = createMemo(() => {
    const set = new Set<string>();
    for (const t of shellPty.store.tabs) set.add(t.projectPath);
    const active = activeProjectPath();
    if (active && shellPanel.openedFor(active)) set.add(active);
    return Array.from(set);
  });

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
    // Tear down diff-panel tabs first. Edit tabs may surface a Save/Discard/
    // Cancel prompt via their close guard; if the user picks Cancel the
    // returned `kept` count is non-zero and we abort the rest of the close.
    const { kept } = await diffPanel.clearProject(path);
    if (kept > 0) return;
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
    // Defensive: clearProject already SIGHUP'd editor tabs through the
    // onBeforeClose hook, but the project may have lived without a diff
    // panel ever opening — kill anything still alive directly.
    editorPty.killAllForProject(path);
    shellPty.killAllForProject(path);
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

  // `klaudio <path>` from the shell delivers a klaudio://open?path=... URL,
  // which Rust's deep-link handler turns into a `cli:open` event. Always open
  // a brand-new Claude tab (never reuse an existing one or resume) — that's
  // the contract: the user invoked the CLI expressly, they get a fresh tab.
  // If the path was a file, also route it into the diff panel.
  async function handleCliOpen(projectPath: string, filePath?: string) {
    // Suppress auto-resume for this project — the user's intent is a fresh
    // tab, not continuation. Adding to the set BEFORE setActiveProjectPath
    // short-circuits the maybeAutoResume call inside the active-path effect.
    autoResumed.add(projectPath);
    projects.touch(projectPath);
    setActiveProjectPath(projectPath);
    try {
      await term.openTab(projectPath, [], {
        label: "New session",
        sessionId: null,
      });
    } catch (err) {
      console.error("cli:open → openTab failed", err);
    } finally {
      setSessionsRefresh((k) => k + 1);
    }
    if (filePath) {
      const rel = relPathInside(projectPath, filePath);
      if (rel) diffPanel.openFile(projectPath, rel);
    }
  }

  onMount(() => {
    const unlistens: Array<() => void> = [];

    void listen<{ project_path: string; file_path: string | null }>(
      "cli:open",
      (e) => {
        void handleCliOpen(e.payload.project_path, e.payload.file_path ?? undefined);
      },
    ).then((off) => unlistens.push(off));

    void listen("menu:install-cli", async () => {
      try {
        const where = await invoke<string>("install_cli");
        await message(installSuccessMessage(where), {
          title: "klaudio CLI installed",
          kind: "info",
        });
      } catch (err) {
        await message(String(err), {
          title: "Install failed",
          kind: "error",
        });
      }
    }).then((off) => unlistens.push(off));

    void listen("menu:uninstall-cli", async () => {
      try {
        await invoke("uninstall_cli");
        await message(
          "The klaudio command has been removed from PATH.\n\nOpen a new terminal window — shells opened before this will still have klaudio cached until you run `rehash` (zsh) or `hash -r` (bash).",
          { title: "klaudio CLI uninstalled", kind: "info" },
        );
      } catch (err) {
        await message(String(err), {
          title: "Uninstall failed",
          kind: "error",
        });
      }
    }).then((off) => unlistens.push(off));

    onCleanup(() => {
      for (const off of unlistens) off();
    });
  });

  return (
    <div class="h-screen w-screen flex flex-col bg-neutral-950 text-neutral-200 overflow-hidden">
      <CommandPalette
        projectPath={activeProjectPath()}
        onSelectSession={handleSelectSession}
      />
      <Titlebar
        hasActiveProject={activeProjectPath() !== null}
        activeProjectPath={activeProjectPath()}
      />
      <NotificationToastStack />
      <main class="flex-1 flex min-h-0 overflow-hidden">
      <ProjectsSidebar
        activePath={activeProjectPath()}
        onActivate={setActiveProjectPath}
        onAdd={handleAddProject}
        onGoHome={goHome}
        onCloseProject={(path) => void handleCloseProject(path)}
        openTabsByProject={openTabsByProject()}
      />

      {/* The project view stays mounted across home round-trips —
          otherwise every TerminalView / ShellTerminalView would unmount
          when the user hits the home icon, losing the Claude WebGL
          buffer (recoverable with a SIGWINCH because Ink redraws) and
          the bash shell scrollback (NOT recoverable, because that
          scrollback lives in xterm, not in bash). Absolute-positioning
          both layers lets HomeScreen overlay while the project view
          survives underneath with its xterms intact. */}
      <div class="flex-1 relative min-w-0 min-h-0">
        <div
          ref={sidebarRowRef}
          class="absolute inset-0 flex min-w-0 min-h-0 overflow-hidden"
          style={{
            visibility: activeProjectPath() ? "visible" : "hidden",
            "pointer-events": activeProjectPath() ? "auto" : "none",
          }}
        >
          <Show when={activeProjectPath()}>
            {(p) => (
              <SidebarPanel
                projectPath={p()}
                width={panelLayout().sidebarEff}
                sessionsContent={
                  <SessionsList
                    projectPath={p()}
                    activeSessionId={activeSessionId()}
                    openSessionIds={openSessionIds()}
                    openingSessionIds={openingSessionIds()}
                    onNew={() => void openNewTab()}
                    onSelect={handleSelectSession}
                    onRefresh={() => setSessionsRefresh((k) => k + 1)}
                    refreshKey={sessionsRefresh()}
                  />
                }
                filesContent={<FileTree projectPath={p()} />}
              />
            )}
          </Show>
          <Show
            when={
              activeProjectPath() && !sidebar.collapsed()
                ? activeProjectPath()
                : null
            }
          >
            {(p) => (
              <SplitDivider
                edge="left"
                width={panelLayout().sidebarEff}
                onResize={(w) => sidebar.setWidth(p(), w)}
                onResizeEnd={(w) => sidebar.setWidth(p(), w)}
                getParentRect={() => sidebarRowRef.getBoundingClientRect()}
                minSelf={SIDEBAR_MIN}
                minOther={
                  CENTER_MIN + (panelLayout().diffVisible ? DIFF_MIN : 0)
                }
                maxFraction={0.5}
              />
            )}
          </Show>

          {/* Central column: Claude terminal + diff panel (row) on top,
              shell terminal dock below. Sits to the right of SidebarPanel
              so the dock never steals space from Sessions/Files. */}
          <div class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          <div
            ref={splitContainerRef}
            class="flex-1 flex min-w-0 min-h-0 overflow-hidden"
          >
            <section class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
              <Show when={activeProjectPath()}>
                <TabStrip
                  tabs={projectTabs()}
                  activeTabId={term.store.activeTabId}
                  onActivate={handleActivateTab}
                  onClose={(id) => void handleCloseTab(id)}
                  onNew={() => void openNewTab()}
                  canOpenNew={!anyTabOpeningForActive()}
                />
              </Show>
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
                <Show
                  when={
                    activeProjectPath() &&
                    (projectTabs().length === 0 ||
                      !activeTab() ||
                      activeTab()?.projectPath !== activeProjectPath())
                  }
                >
                  <div class="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm">
                    Pick a session or start a new one.
                  </div>
                </Show>
              </div>
            </section>
            <Show
              when={
                panelLayout().diffVisible ? activeProjectPath() : null
              }
            >
              {(p) => (
                <>
                  <SplitDivider
                    width={panelLayout().diffEff}
                    onResize={(w) => diffPanel.setWidth(p(), w)}
                    onResizeEnd={(w) => diffPanel.setWidth(p(), w)}
                    getParentRect={() =>
                      splitContainerRef.getBoundingClientRect()
                    }
                    minSelf={DIFF_MIN}
                    minOther={
                      CENTER_MIN + (sidebarVisible() ? SIDEBAR_MIN : 0)
                    }
                    maxFraction={0.5}
                  />
                  <div
                    class="shrink-0 min-h-0 flex flex-col overflow-hidden"
                    style={{ width: `${panelLayout().diffEff}px` }}
                  >
                    <DiffPanel projectPath={p()} />
                  </div>
                </>
              )}
            </Show>
          </div>
          {/* Shell dock. Mount a ShellTerminalPanel for every project that
              has live shell PTYs, plus the active project if its panel is
              open (first-open auto-spawn). Only the active project's panel
              is visible; the rest are absolute-positioned + visibility:
              hidden so their xterm scrollback survives project switches.
              Without this, flipping activeProject disposes the panel and
              the next mount is a fresh xterm with no history. Same pattern
              as the Claude tab strip above. Container height collapses to
              0 when the active project's panel is closed, so the dock
              doesn't steal space from projects without a shell open. */}
          <div
            class="relative shrink-0 overflow-hidden"
            style={{
              height: (() => {
                const p = activeProjectPath();
                return p && shellPanel.openedFor(p)
                  ? `${shellPanel.heightPx()}px`
                  : "0px";
              })(),
            }}
          >
            <For each={shellMountedProjects()}>
              {(p) => {
                const visible = () =>
                  p === activeProjectPath() && shellPanel.openedFor(p);
                return (
                  <div
                    class="absolute inset-0"
                    style={{
                      visibility: visible() ? "visible" : "hidden",
                      "pointer-events": visible() ? "auto" : "none",
                    }}
                  >
                    <ShellTerminalPanel
                      projectPath={p}
                      isActive={visible()}
                    />
                  </div>
                );
              }}
            </For>
          </div>
          </div>
        </div>
        <Show when={!activeProjectPath()}>
          <div class="absolute inset-0">
            <HomeScreen onPick={handlePickFromHome} />
          </div>
        </Show>
      </div>
      </main>
      <Toaster />
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

installGlobalErrorForwarding();

export default function App() {
  return (
    <ProjectsProvider>
      <SidebarProvider>
        <GitProvider>
          <RevealProvider>
            <DiffPanelProvider>
              <OpenInProvider>
                <EditorPtyProvider>
                  <ShellPanelProvider>
                    <ShellPtyProvider>
                      <TerminalProvider>
                        <SessionWatcherProvider>
                          <NotificationsProvider>
                            <CommandPaletteProvider>
                              <Shell />
                            </CommandPaletteProvider>
                          </NotificationsProvider>
                        </SessionWatcherProvider>
                      </TerminalProvider>
                    </ShellPtyProvider>
                  </ShellPanelProvider>
                </EditorPtyProvider>
              </OpenInProvider>
            </DiffPanelProvider>
          </RevealProvider>
        </GitProvider>
      </SidebarProvider>
    </ProjectsProvider>
  );
}
