import { createEffect, createSignal, Show } from "solid-js";
import { ProjectPicker } from "@/components/project-picker";
import { SessionsList } from "@/components/sessions-list";

function App() {
  const [projectPath, setProjectPath] = createSignal<string | null>(
    localStorage.getItem("projectPath"),
  );
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null);
  const [sessionsRefresh] = createSignal(0);

  createEffect(() => {
    const p = projectPath();
    if (p) localStorage.setItem("projectPath", p);
    else localStorage.removeItem("projectPath");
  });

  function handleChangeProject() {
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
                onClick={handleChangeProject}
              >
                ← cambiar
              </button>
            </div>
            <SessionsList
              projectPath={projectPath()!}
              activeSessionId={activeSessionId()}
              onNew={() => setActiveSessionId(null)}
              onSelect={(id) => setActiveSessionId(id)}
              refreshKey={sessionsRefresh()}
            />
          </aside>
          <section class="min-w-0 flex items-center justify-center text-neutral-500 text-sm">
            Terminal pending — T4–T7 will wire xterm.js here.
          </section>
        </div>
      </Show>
    </main>
  );
}

export default App;
