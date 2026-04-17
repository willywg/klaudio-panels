import { createEffect, createSignal, Show } from "solid-js";
import { ProjectPicker } from "@/components/project-picker";
import { SessionsList } from "@/components/sessions-list";
import { TerminalView } from "@/components/terminal-view";
import { TerminalProvider, useTerminal } from "@/context/terminal";

function Shell() {
  const [projectPath, setProjectPath] = createSignal<string | null>(
    localStorage.getItem("projectPath"),
  );
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null);
  const [sessionsRefresh, setSessionsRefresh] = createSignal(0);
  const [opening, setOpening] = createSignal(false);
  const term = useTerminal();

  createEffect(() => {
    const p = projectPath();
    if (p) localStorage.setItem("projectPath", p);
    else localStorage.removeItem("projectPath");
  });

  async function openPty(args: string[]) {
    const p = projectPath();
    if (!p) return;
    setOpening(true);
    try {
      await term.open(p, args);
    } finally {
      setOpening(false);
      setSessionsRefresh((k) => k + 1);
    }
  }

  async function handleNew() {
    setActiveSessionId(null);
    await openPty([]);
  }

  async function handleSelect(id: string) {
    setActiveSessionId(id);
    await openPty(["--resume", id]);
  }

  async function handleChangeProject() {
    await term.kill();
    setActiveSessionId(null);
    setProjectPath(null);
  }

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
              onNew={() => void handleNew()}
              onSelect={(id) => void handleSelect(id)}
              refreshKey={sessionsRefresh()}
            />
          </aside>

          <section class="min-w-0 min-h-0 flex flex-col overflow-hidden">
            <Show
              when={term.store.id && !opening()}
              fallback={
                <Show
                  when={opening()}
                  fallback={
                    <div class="flex-1 flex items-center justify-center text-neutral-500 text-sm">
                      Elige una sesión o crea una nueva para empezar.
                    </div>
                  }
                >
                  <LoadingPanel />
                </Show>
              }
            >
              <TerminalView />
            </Show>
          </section>
        </div>
      </Show>
    </main>
  );
}

function LoadingPanel() {
  return (
    <div class="flex-1 flex items-center justify-center">
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
