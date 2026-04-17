import { createSignal, Show } from "solid-js";

function App() {
  const [projectPath, setProjectPath] = createSignal<string | null>(
    localStorage.getItem("projectPath"),
  );

  return (
    <main class="h-screen w-screen flex flex-col bg-neutral-950 text-neutral-200">
      <Show
        when={projectPath()}
        fallback={
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <h1 class="text-2xl font-semibold mb-2">Claude Desktop</h1>
              <p class="text-neutral-400 mb-6">PoC scaffold ready.</p>
              <button
                class="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-md text-sm"
                onClick={() => setProjectPath("/tmp/stub")}
              >
                Abrir proyecto (stub)
              </button>
            </div>
          </div>
        }
      >
        <div class="flex-1 grid grid-cols-[260px_1fr]">
          <aside class="border-r border-neutral-800 p-4">
            <div class="text-xs uppercase tracking-wider text-neutral-500 mb-2">
              Proyecto
            </div>
            <div class="text-sm truncate">{projectPath()}</div>
            <button
              class="mt-4 text-xs text-neutral-400 hover:text-neutral-200"
              onClick={() => {
                localStorage.removeItem("projectPath");
                setProjectPath(null);
              }}
            >
              ← cambiar
            </button>
          </aside>
          <section class="p-4">
            <div class="text-neutral-400 text-sm">
              Chat pendiente. Tareas T2–T7 cablearán esto.
            </div>
          </section>
        </div>
      </Show>
    </main>
  );
}

export default App;
