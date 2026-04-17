import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  onMount,
} from "solid-js";
import { ProjectPicker } from "@/components/project-picker";
import { SessionsList, type SessionMeta } from "@/components/sessions-list";
import { TerminalView } from "@/components/terminal-view";
import { TabStrip } from "@/components/tab-strip";
import {
  getLastSessionId,
  setLastSessionId,
} from "@/components/last-session";
import { TerminalProvider, useTerminal } from "@/context/terminal";
import { displayLabel } from "@/lib/session-label";

const AUTO_RESUME_FAIL_WINDOW_MS = 2000;

function Shell() {
  const [projectPath, setProjectPath] = createSignal<string | null>(
    localStorage.getItem("projectPath"),
  );
  const [sessionsRefresh, setSessionsRefresh] = createSignal(0);
  const term = useTerminal();

  createEffect(() => {
    const p = projectPath();
    if (p) localStorage.setItem("projectPath", p);
    else localStorage.removeItem("projectPath");
  });

  const activeTab = createMemo(() => {
    const id = term.store.activeTabId;
    if (!id) return undefined;
    return term.store.tabs.find((t) => t.id === id);
  });

  const activeSessionId = () => activeTab()?.sessionId ?? null;

  const openSessionIds = createMemo(() => {
    const set = new Set<string>();
    for (const t of term.store.tabs)
      if (t.sessionId && t.status !== "opening") set.add(t.sessionId);
    return set;
  });

  const openingSessionIds = createMemo(() => {
    const set = new Set<string>();
    for (const t of term.store.tabs)
      if (t.sessionId && t.status === "opening") set.add(t.sessionId);
    return set;
  });

  const anyTabOpening = createMemo(() =>
    term.store.tabs.some((t) => t.status === "opening"),
  );

  // Persist the last sessionId for the current project whenever the active
  // tab changes to one with a sessionId. Tabs without sessionId don't update
  // the key — they stay invisible to persistence until Sprint 03 correlates
  // them via JSONL watcher.
  createEffect(() => {
    const p = projectPath();
    const sid = activeSessionId();
    if (!p) return;
    if (sid) setLastSessionId(p, sid);
  });

  async function openNewTab() {
    const p = projectPath();
    if (!p) return;
    try {
      await term.openTab(p, [], {
        label: "Nueva sesión",
        sessionId: null,
      });
    } catch (err) {
      console.error("openTab(new) failed", err);
    } finally {
      setSessionsRefresh((k) => k + 1);
    }
  }

  async function openResumeTab(sessionId: string, label: string) {
    const p = projectPath();
    if (!p) return;
    try {
      await term.openTab(p, ["--resume", sessionId], {
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
    // Dedupe: if there's already a tab (pending or running) for this
    // sessionId, just activate it. This is what prevents rapid-click spam.
    const existing = term.findTabBySessionId(meta.id);
    if (existing) {
      term.setActiveTab(existing.id);
      return;
    }
    void openResumeTab(meta.id, displayLabel(meta));
  }

  function handleActivate(id: string) {
    term.setActiveTab(id);
  }

  async function handleClose(id: string) {
    await term.closeTab(id);
  }

  async function handleChangeProject() {
    await term.closeAll();
    setProjectPath(null);
  }

  // Auto-resume on mount if the current project has a persisted lastSessionId.
  // If the spawned PTY exits within AUTO_RESUME_FAIL_WINDOW_MS, treat it as a
  // silent failure (session likely deleted), clear the key, and close the tab.
  onMount(() => {
    const p = projectPath();
    if (!p) return;
    const lastId = getLastSessionId(p);
    if (!lastId) return;

    const spawnedAt = Date.now();
    const label = `session ${lastId.slice(0, 8)}`;
    term
      .openTab(p, ["--resume", lastId], { label, sessionId: lastId })
      .then((tabId) => {
        const detach = term.onExit(tabId, (code) => {
          const elapsed = Date.now() - spawnedAt;
          if (elapsed < AUTO_RESUME_FAIL_WINDOW_MS && code !== 0) {
            console.info(
              `auto-resume failed for ${lastId} (exit ${code} after ${elapsed}ms). Clearing lastSessionId.`,
            );
            setLastSessionId(p, null);
            void term.closeTab(tabId);
          }
          detach();
        });
      })
      .catch((err) => {
        console.warn("auto-resume openTab threw", err);
        setLastSessionId(p, null);
      })
      .finally(() => {
        setSessionsRefresh((k) => k + 1);
      });
  });

  return (
    <main class="h-screen w-screen flex flex-col bg-neutral-950 text-neutral-200 overflow-hidden">
      <Show
        when={projectPath()}
        fallback={<ProjectPicker onPick={(p) => setProjectPath(p)} />}
      >
        <div class="flex-1 grid grid-cols-[280px_1fr] min-h-0 overflow-hidden">
          <aside class="border-r border-neutral-800 flex flex-col min-h-0 overflow-hidden">
            <div class="px-3 py-2 border-b border-neutral-800">
              <div class="text-[10px] uppercase tracking-wider text-neutral-500">
                Proyecto
              </div>
              <div class="text-xs text-neutral-300 truncate" title={projectPath()!}>
                {projectPath()!.split("/").slice(-2).join("/")}
              </div>
              <button
                class="mt-1 text-[11px] text-neutral-500 hover:text-neutral-300"
                onClick={() => void handleChangeProject()}
              >
                ← cambiar
              </button>
            </div>
            <SessionsList
              projectPath={projectPath()!}
              activeSessionId={activeSessionId()}
              openSessionIds={openSessionIds()}
              openingSessionIds={openingSessionIds()}
              onNew={() => void openNewTab()}
              onSelect={handleSelectSession}
              refreshKey={sessionsRefresh()}
            />
          </aside>

          <section class="min-w-0 min-h-0 flex flex-col overflow-hidden">
            <TabStrip
              tabs={term.store.tabs}
              activeTabId={term.store.activeTabId}
              onActivate={handleActivate}
              onClose={(id) => void handleClose(id)}
              onNew={() => void openNewTab()}
              canOpenNew={!anyTabOpening()}
            />
            <div class="relative flex-1 min-h-0 overflow-hidden">
              <For each={term.store.tabs}>
                {(tab) => {
                  const isActive = () => tab.id === term.store.activeTabId;
                  return (
                    <div
                      class="absolute inset-0 flex flex-col"
                      style={{
                        visibility: isActive() ? "visible" : "hidden",
                        "pointer-events": isActive() ? "auto" : "none",
                        "z-index": isActive() ? 1 : 0,
                      }}
                    >
                      <Show
                        when={tab.status !== "opening"}
                        fallback={<LoadingPanel label={tab.label} />}
                      >
                        <TerminalView id={tab.id} active={isActive()} />
                      </Show>
                    </div>
                  );
                }}
              </For>
              <Show when={term.store.tabs.length === 0}>
                <div class="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm">
                  Elige una sesión o crea una nueva para empezar.
                </div>
              </Show>
            </div>
          </section>
        </div>
      </Show>
    </main>
  );
}

function LoadingPanel(props: { label?: string }) {
  return (
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="flex flex-col items-center gap-3 text-neutral-400 text-sm">
        <div class="flex items-center gap-3">
          <div class="w-4 h-4 border-2 border-neutral-700 border-t-indigo-500 rounded-full animate-spin" />
          <span>Iniciando Claude Code…</span>
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
    <TerminalProvider>
      <Shell />
    </TerminalProvider>
  );
}
