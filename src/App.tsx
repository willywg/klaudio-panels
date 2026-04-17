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
  const term = useTerminal();

  createEffect(() => {
    const p = projectPath();
    if (p) localStorage.setItem("projectPath", p);
    else localStorage.removeItem("projectPath");
  });

  async function handleNew() {
    const p = projectPath();
    if (!p) return;
    setActiveSessionId(null);
    await term.open(p, []);
    setSessionsRefresh((k) => k + 1);
  }

  async function handleSelect(id: string) {
    const p = projectPath();
    if (!p) return;
    setActiveSessionId(id);
    await term.open(p, ["--resume", id]);
  }

  async function handleChangeProject() {
    await term.kill();
    setActiveSessionId(null);
    setProjectPath(null);
  }

  return (
    <main class="h-screen w-screen flex flex-col bg-neutral-950 text-neutral-200">
      <Show
        when={projectPath()}
        fallback={<ProjectPicker onPick={(p) => setProjectPath(p)} />}
      >
        <div class="flex-1 grid grid-cols-[280px_1fr] min-h-0">
          <aside class="border-r border-neutral-800 flex flex-col min-h-0">
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
              onNew={() => void handleNew()}
              onSelect={(id) => void handleSelect(id)}
              refreshKey={sessionsRefresh()}
            />
          </aside>
          <section class="min-w-0 flex flex-col min-h-0">
            <Show
              when={term.store.id}
              fallback={
                <div class="flex-1 flex items-center justify-center text-neutral-500 text-sm">
                  Elige una sesión o crea una nueva para empezar.
                </div>
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

export default function App() {
  return (
    <TerminalProvider>
      <Shell />
    </TerminalProvider>
  );
}
