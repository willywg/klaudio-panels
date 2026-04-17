import { For, Show } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Home, Plus } from "lucide-solid";
import {
  projectColor,
  projectInitial,
  projectLabel,
} from "@/lib/recent-projects";
import { useProjects } from "@/context/projects";

type Props = {
  activePath: string | null;
  onActivate: (path: string) => void;
  onAdd: (path: string) => void;
  onGoHome: () => void;
  openTabsByProject: Map<string, number>;
};

export function ProjectsSidebar(props: Props) {
  const projects = useProjects();

  async function handleAdd() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") props.onAdd(picked);
  }

  return (
    <nav class="w-14 shrink-0 bg-neutral-950 border-r border-neutral-800 flex flex-col items-center py-3 gap-2 overflow-y-auto">
      <button
        class={
          "w-10 h-10 rounded-lg flex items-center justify-center transition " +
          (props.activePath === null
            ? "bg-neutral-800 text-neutral-100"
            : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900")
        }
        title="Inicio"
        onClick={props.onGoHome}
      >
        <Home size={18} strokeWidth={2} />
      </button>
      <div class="w-8 h-px bg-neutral-800 my-1" />
      <For each={projects.list}>
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
                    projects.remove(proj.path);
                  }
                }}
                class={
                  "w-10 h-10 rounded-lg flex items-center justify-center text-[15px] font-semibold text-white transition shadow-sm " +
                  (isActive()
                    ? "ring-2 ring-indigo-500 ring-offset-2 ring-offset-neutral-950"
                    : "opacity-85 hover:opacity-100 hover:scale-[1.03]")
                }
                style={{ "background-color": color() }}
                title={`${label()}\n${proj.path}${openCount() > 0 ? `\n${openCount()} tab(s) abiertos` : ""}`}
              >
                {initial()}
              </button>
              <Show when={openCount() > 0}>
                <span class="absolute -bottom-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full bg-green-500 text-[10px] font-bold text-neutral-950 flex items-center justify-center px-1 border-2 border-neutral-950">
                  {openCount()}
                </span>
              </Show>
            </div>
          );
        }}
      </For>
      <button
        class="w-10 h-10 rounded-lg border border-dashed border-neutral-700 text-neutral-500 hover:border-neutral-500 hover:text-neutral-200 flex items-center justify-center transition"
        title="Agregar proyecto"
        onClick={handleAdd}
      >
        <Plus size={18} strokeWidth={2} />
      </button>
    </nav>
  );
}
