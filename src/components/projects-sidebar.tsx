import { createSignal, For, Show } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Home, Plus, X } from "lucide-solid";
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
  onCloseProject: (path: string) => void;
  openTabsByProject: Map<string, number>;
};

export function ProjectsSidebar(props: Props) {
  const projects = useProjects();
  const [draggingPath, setDraggingPath] = createSignal<string | null>(null);
  const [dragOverPath, setDragOverPath] = createSignal<string | null>(null);

  async function handleAdd() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") props.onAdd(picked);
  }

  function handleCloseClick(e: MouseEvent, path: string) {
    e.stopPropagation();
    const label = projectLabel(path);
    const openCount = props.openTabsByProject.get(path) ?? 0;
    const msg =
      openCount > 0
        ? `Cerrar "${label}"?\nEsto matará ${openCount} tab(s) abiertos y lo quitará del sidebar.`
        : `Cerrar "${label}"?\nSe quitará del sidebar.`;
    if (confirm(msg)) props.onCloseProject(path);
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
          const isDragging = () => draggingPath() === proj.path;
          const isDragOver = () =>
            dragOverPath() === proj.path && draggingPath() !== proj.path;
          return (
            <div
              class="relative group"
              draggable={true}
              onDragStart={(e) => {
                setDraggingPath(proj.path);
                e.dataTransfer!.effectAllowed = "move";
                e.dataTransfer!.setData("text/plain", proj.path);
              }}
              onDragEnd={() => {
                setDraggingPath(null);
                setDragOverPath(null);
              }}
              onDragOver={(e) => {
                if (!draggingPath() || draggingPath() === proj.path) return;
                e.preventDefault();
                e.dataTransfer!.dropEffect = "move";
                setDragOverPath(proj.path);
              }}
              onDragLeave={() => {
                if (dragOverPath() === proj.path) setDragOverPath(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = draggingPath();
                if (from && from !== proj.path) {
                  projects.reorder(from, proj.path);
                }
                setDraggingPath(null);
                setDragOverPath(null);
              }}
              style={{ opacity: isDragging() ? "0.4" : "1" }}
            >
              <Show when={isDragOver()}>
                <span class="absolute -left-2 top-0 bottom-0 w-0.5 rounded-full bg-indigo-400" />
              </Show>
              <button
                onClick={() => props.onActivate(proj.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  handleCloseClick(e, proj.path);
                }}
                class={
                  "w-10 h-10 rounded-lg flex items-center justify-center text-[15px] font-semibold text-white transition shadow-sm cursor-grab active:cursor-grabbing " +
                  (isActive()
                    ? "ring-2 ring-indigo-500 ring-offset-2 ring-offset-neutral-950"
                    : "opacity-85 hover:opacity-100 hover:scale-[1.03]")
                }
                style={{ "background-color": color() }}
                title={`${label()}\n${proj.path}${openCount() > 0 ? `\n${openCount()} tab(s) abiertos` : ""}\n\nArrastra para reordenar. Right-click o × para cerrar.`}
              >
                {initial()}
              </button>
              <Show when={openCount() > 0}>
                <span class="absolute -bottom-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full bg-green-500 text-[10px] font-bold text-neutral-950 flex items-center justify-center px-1 border-2 border-neutral-950 pointer-events-none">
                  {openCount()}
                </span>
              </Show>
              <button
                class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-neutral-800 text-neutral-300 hover:bg-red-600 hover:text-white border border-neutral-950 flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                title="Cerrar proyecto"
                onClick={(e) => handleCloseClick(e, proj.path)}
              >
                <X size={9} strokeWidth={3} />
              </button>
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
