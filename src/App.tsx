import { createEffect, createMemo, createSignal, For, Show, onMount } from "solid-js";
import { ProjectPicker } from "@/components/project-picker";
import { SessionsList } from "@/components/sessions-list";
import { TerminalView } from "@/components/terminal-view";
import { TabStrip } from "@/components/tab-strip";
import {
  getLastSessionId,
  setLastSessionId,
} from "@/components/last-session";
import { TerminalProvider, useTerminal } from "@/context/terminal";

const AUTO_RESUME_FAIL_WINDOW_MS = 2000;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function Shell() {
  const [projectPath, setProjectPath] = createSignal<string | null>(
    localStorage.getItem("projectPath"),
  );
  const [sessionsRefresh, setSessionsRefresh] = createSignal(0);
  const [opening, setOpening] = createSignal(false);
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
    for (const t of term.store.tabs) if (t.sessionId) set.add(t.sessionId);
    return set;
  });

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
    setOpening(true);
    try {
      await term.openTab(p, [], { label: "Nueva sesión", sessionId: null });
    } catch (err) {
      console.error("openTab(new) failed", err);
    } finally {
      setOpening(false);
      setSessionsRefresh((k) => k + 1);
    }
  }

  async function openResumeTab(sessionId: string, label: string) {
    const p = projectPath();
    if (!p) return;
    setOpening(true);
    try {
      await term.openTab(p, ["--resume", sessionId], { label, sessionId });
    } catch (err) {
      console.error("openTab(resume) failed", err);
    } finally {
      setOpening(false);
      setSessionsRefresh((k) => k + 1);
    }
  }

  function handleSelect(sessionId: string) {
    const existing = term.store.tabs.find((t) => t.sessionId === sessionId);
    if (existing) {
      term.setActiveTab(existing.id);
      return;
    }
    const label = truncate(`session ${sessionId.slice(0, 8)}`, 28);
    void openResumeTab(sessionId, label);
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
    const label = truncate(`session ${lastId.slice(0, 8)}`, 28);
    setOpening(true);
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
        setOpening(false);
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
                disabled={opening()}
              >
                ← cambiar
              </button>
            </div>
            <SessionsList
              projectPath={projectPath()!}
              activeSessionId={activeSessionId()}
              openSessionIds={openSessionIds()}
              onNew={() => void openNewTab()}
              onSelect={handleSelect}
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
              canOpenNew={!opening()}
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
                      <TerminalView id={tab.id} active={isActive()} />
                    </div>
                  );
                }}
              </For>
              <Show when={term.store.tabs.length === 0 && !opening()}>
                <div class="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm">
                  Elige una sesión o crea una nueva para empezar.
                </div>
              </Show>
              <Show when={opening() && term.store.tabs.length === 0}>
                <LoadingPanel />
              </Show>
            </div>
          </section>
        </div>
      </Show>
    </main>
  );
}

function LoadingPanel() {
  return (
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="flex items-center gap-3 text-neutral-400 text-sm">
        <div class="w-4 h-4 border-2 border-neutral-700 border-t-indigo-500 rounded-full animate-spin" />
        <span>Iniciando Claude Code…</span>
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
