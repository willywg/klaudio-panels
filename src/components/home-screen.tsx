import { For, Show } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  projectLabel,
  recentProjectsSignal,
  relativeTime,
} from "@/lib/recent-projects";

type Props = {
  onPick: (path: string) => void;
};

export function HomeScreen(props: Props) {
  const recents = recentProjectsSignal;

  async function handleOpen() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") props.onPick(picked);
  }

  return (
    <div class="flex-1 flex flex-col items-center justify-center px-6 py-10 overflow-y-auto">
      <div class="w-full max-w-2xl">
        <div class="text-center mb-10">
          <h1 class="text-4xl font-semibold tracking-tight text-neutral-300 mb-3">
            Claude Code UI
          </h1>
          <div class="flex items-center justify-center gap-2 text-xs text-neutral-500">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
            <span>Listo</span>
          </div>
        </div>

        <div class="flex items-center justify-between mb-3 px-1">
          <h2 class="text-sm text-neutral-300">Proyectos recientes</h2>
          <button
            class="text-xs px-3 py-1.5 border border-neutral-700 rounded hover:bg-neutral-900 hover:border-neutral-600 text-neutral-200 transition"
            onClick={handleOpen}
          >
            📁 Abrir proyecto
          </button>
        </div>

        <div class="border border-neutral-800 rounded-lg overflow-hidden">
          <Show
            when={recents().length > 0}
            fallback={
              <div class="px-4 py-8 text-center text-sm text-neutral-500">
                No has abierto ningún proyecto todavía.
                <br />
                Click <strong class="text-neutral-300">Abrir proyecto</strong> para empezar.
              </div>
            }
          >
            <For each={recents()}>
              {(p, i) => (
                <button
                  onClick={() => props.onPick(p.path)}
                  class={
                    "w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-neutral-900/60 transition " +
                    (i() === 0 ? "" : "border-t border-neutral-800/60")
                  }
                >
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-neutral-200 truncate font-mono">
                      {abbreviateHome(p.path)}
                    </div>
                    <div class="text-[11px] text-neutral-500 truncate mt-0.5">
                      {projectLabel(p.path)}
                    </div>
                  </div>
                  <div class="text-[11px] text-neutral-500 shrink-0 ml-4">
                    {relativeTime(p.lastOpened)}
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

function abbreviateHome(path: string): string {
  const home = homePath();
  if (home && path.startsWith(home)) return "~" + path.slice(home.length);
  return path;
}

function homePath(): string | null {
  // Rough heuristic — localStorage fallback. Tauri API call would be ideal
  // but requires an async fetch on mount; for display-only we accept this.
  const stored = localStorage.getItem("__home");
  if (stored) return stored;
  // Try to derive from an existing recent project.
  const recents = recentProjectsSignal();
  for (const r of recents) {
    const m = r.path.match(/^(\/Users\/[^/]+)/);
    if (m) {
      localStorage.setItem("__home", m[1]);
      return m[1];
    }
  }
  return null;
}
