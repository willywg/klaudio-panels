import { For, Show } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  projectColor,
  projectInitial,
  projectLabel,
  recentProjectsSignal,
  removeProject,
} from "@/lib/recent-projects";

type Props = {
  activePath: string | null;
  onActivate: (path: string) => void;
  onAdd: (path: string) => void;
  onGoHome: () => void;
  openTabsByProject: Map<string, number>;
};

export function ProjectsSidebar(props: Props) {
  const recents = recentProjectsSignal;

  async function handleAdd() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") props.onAdd(picked);
  }

  return (
    <nav class="w-12 shrink-0 bg-neutral-950 border-r border-neutral-800 flex flex-col items-center py-2 gap-2 overflow-y-auto">
      <button
        class={
          "w-8 h-8 rounded flex items-center justify-center text-[12px] font-bold tracking-tight " +
          (props.activePath === null
            ? "bg-neutral-800 text-neutral-100"
            : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900")
        }
        title="Inicio"
        onClick={props.onGoHome}
      >
        ⌂
      </button>
      <div class="w-6 h-px bg-neutral-800 my-1" />
      <For each={recents()}>
        {(proj) => {
          const isActive = () => props.activePath === proj.path;
          const openCount = () => props.openTabsByProject.get(proj.path) ?? 0;
          const label = () => projectLabel(proj.path);
          const initial = () => projectInitial(proj.path);
          const color = () => projectColor(proj.path);
          return (
            <div class="relative">
              <button
                onClick={() => props.onActivate(proj.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (
                    confirm(`Remover "${label()}" del historial de proyectos?`)
                  ) {
                    removeProject(proj.path);
                  }
                }}
                class={
                  "w-8 h-8 rounded flex items-center justify-center text-[13px] font-semibold text-white transition " +
                  (isActive()
                    ? "ring-2 ring-indigo-500 ring-offset-2 ring-offset-neutral-950"
                    : "opacity-85 hover:opacity-100")
                }
                style={{ "background-color": color() }}
                title={`${label()}\n${proj.path}${openCount() > 0 ? `\n${openCount()} tab(s) abiertos` : ""}`}
              >
                {initial()}
              </button>
              <Show when={openCount() > 0}>
                <span class="absolute -bottom-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-green-500 text-[9px] font-bold text-neutral-950 flex items-center justify-center px-0.5 border border-neutral-950">
                  {openCount()}
                </span>
              </Show>
            </div>
          );
        }}
      </For>
      <button
        class="w-8 h-8 rounded border border-dashed border-neutral-700 text-neutral-500 hover:border-neutral-500 hover:text-neutral-200 flex items-center justify-center text-[16px] leading-none"
        title="Agregar proyecto"
        onClick={handleAdd}
      >
        +
      </button>
    </nav>
  );
}
