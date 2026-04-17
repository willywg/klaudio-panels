import { createEffect, createSignal, Show } from "solid-js";
import { ProjectPicker } from "@/components/project-picker";
import { SessionsList } from "@/components/sessions-list";
import { ChatView } from "@/components/chat-view";
import { ClaudeProvider, useClaude } from "@/context/claude";

function Shell() {
  const [projectPath, setProjectPath] = createSignal<string | null>(
    localStorage.getItem("projectPath"),
  );
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null);
  const [sessionsRefresh, setSessionsRefresh] = createSignal(0);
  const ctx = useClaude();

  createEffect(() => {
    const p = projectPath();
    if (p) localStorage.setItem("projectPath", p);
    else localStorage.removeItem("projectPath");
  });

  // When a run ends, refresh the sessions list so a newly-created session
  // appears with the freshly-assigned id.
  createEffect(() => {
    if (ctx.store.status === "idle" && ctx.store.sessionId && !activeSessionId()) {
      setActiveSessionId(ctx.store.sessionId);
      setSessionsRefresh((k) => k + 1);
    }
  });

  function handleNew() {
    ctx.reset();
    setActiveSessionId(null);
  }

  function handleSelect(id: string) {
    ctx.reset();
    setActiveSessionId(id);
  }

  function handleChangeProject() {
    ctx.reset();
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
              onNew={handleNew}
              onSelect={handleSelect}
              refreshKey={sessionsRefresh()}
            />
          </aside>
          <section class="min-w-0">
            <ChatView
              projectPath={projectPath()!}
              activeSessionId={activeSessionId()}
            />
          </section>
        </div>
      </Show>
    </main>
  );
}

export default function App() {
  return (
    <ClaudeProvider>
      <Shell />
    </ClaudeProvider>
  );
}
