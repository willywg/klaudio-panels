import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Home, Pencil, Plus, X } from "lucide-solid";
import {
  MAX_CUSTOM_INITIALS,
  projectColor,
  projectInitial,
  projectLabel,
} from "@/lib/recent-projects";
import { useProjects } from "@/context/projects";
import { useNotifications } from "@/context/notifications";
import { ContextMenu, type ContextMenuItem } from "@/components/context-menu";

type Props = {
  activePath: string | null;
  onActivate: (path: string) => void;
  onAdd: (path: string) => void;
  onGoHome: () => void;
  onCloseProject: (path: string) => void;
  openTabsByProject: Map<string, number>;
};

const HOLD_MS = 180; // press duration that promotes the gesture to a drag
const DRAG_THRESHOLD_PX = 4; // pointer movement that promotes early to drag

export function ProjectsSidebar(props: Props) {
  const projects = useProjects();
  const notifications = useNotifications();
  const [draggingPath, setDraggingPath] = createSignal<string | null>(null);
  const [dragOverPath, setDragOverPath] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const [renaming, setRenaming] = createSignal<{
    path: string;
    value: string;
  } | null>(null);

  // Press state — mutated synchronously by handlers, not reactive.
  let pressPath: string | null = null;
  let pressTimer: number | null = null;
  let pressStart: { x: number; y: number } | null = null;
  let didDrag = false;

  function clearPress() {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressPath = null;
    pressStart = null;
  }

  function onPointerDown(e: PointerEvent, path: string) {
    if (e.button !== 0) return; // left-click only
    pressPath = path;
    pressStart = { x: e.clientX, y: e.clientY };
    didDrag = false;
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      if (pressPath === path) {
        setDraggingPath(path);
        didDrag = true;
      }
    }, HOLD_MS);
  }

  function onWindowPointerMove(e: PointerEvent) {
    // Pre-drag: movement threshold promotes to drag early (typical behaviour).
    if (pressPath && !draggingPath() && pressStart) {
      const dx = e.clientX - pressStart.x;
      const dy = e.clientY - pressStart.y;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        if (pressTimer !== null) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
        setDraggingPath(pressPath);
        didDrag = true;
      }
    }
    // Active drag: find the avatar under the pointer by data attribute.
    if (!draggingPath()) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
    const match = el?.closest("[data-project-path]") as HTMLElement | null;
    const path = match?.dataset.projectPath ?? null;
    if (path && path !== draggingPath()) {
      setDragOverPath(path);
    } else if (!path) {
      setDragOverPath(null);
    }
  }

  function onWindowPointerUp() {
    const from = draggingPath();
    if (from) {
      const to = dragOverPath();
      if (to && to !== from) {
        projects.reorder(from, to);
      }
      setDraggingPath(null);
      setDragOverPath(null);
    }
    clearPress();
    // Let the click-guard stale flag linger for a tick so onClick (fired after
    // pointerup) can check it.
    requestAnimationFrame(() => {
      didDrag = false;
    });
  }

  function onClickAvatar(e: MouseEvent, path: string) {
    if (didDrag) {
      e.preventDefault();
      return;
    }
    props.onActivate(path);
  }

  onMount(() => {
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerUp);
  });
  onCleanup(() => {
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("pointerup", onWindowPointerUp);
    window.removeEventListener("pointercancel", onWindowPointerUp);
  });

  async function handleAdd() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") props.onAdd(picked);
  }

  async function requestClose(path: string) {
    const label = projectLabel(path);
    const openCount = props.openTabsByProject.get(path) ?? 0;
    const msg =
      openCount > 0
        ? `This will kill ${openCount} open tab(s) and remove it from the sidebar.\nIt will still be available under "Recent projects" on the home screen.`
        : `It will be removed from the sidebar. Still available under "Recent projects" on the home screen.`;
    const ok = await confirmDialog(msg, {
      title: `Close "${label}"?`,
      kind: "warning",
    });
    if (ok) props.onCloseProject(path);
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
        title="Home"
        onClick={props.onGoHome}
      >
        <Home size={18} strokeWidth={2} />
      </button>
      <div class="w-8 h-px bg-neutral-800 my-1" />
      <For each={projects.pinned}>
        {(proj) => {
          const isActive = () => props.activePath === proj.path;
          const openCount = () => props.openTabsByProject.get(proj.path) ?? 0;
          const label = () => projectLabel(proj.path);
          const initial = () => projectInitial(proj.path, proj.customInitials);
          const color = () => projectColor(proj.path);
          const isDragging = () => draggingPath() === proj.path;
          const isDragOver = () =>
            dragOverPath() === proj.path && draggingPath() !== proj.path;
          // Steady amber ring whenever the project has an unseen Claude
          // completion. Cleared when the user activates the project.
          // No pulse animation — it was easy to miss on background
          // projects and ended up adding visual noise once multiple
          // projects went amber.
          const unread = () => notifications.isUnread(proj.path);
          return (
            <div class="relative group">
              <Show when={isDragOver()}>
                <span class="absolute -left-2 top-0 bottom-0 w-0.5 rounded-full bg-indigo-400 pointer-events-none" />
              </Show>
              <button
                data-project-path={proj.path}
                onPointerDown={(e) => onPointerDown(e, proj.path)}
                onClick={(e) => onClickAvatar(e, proj.path)}
                onContextMenu={(e) => {
                  // Right-click opens a controlled menu (Rename initials,
                  // Close project) instead of suppressing it outright. Close
                  // still requires confirmation, so the destructive-by-accident
                  // concern from the previous version remains addressed.
                  e.preventDefault();
                  setMenu({
                    path: proj.path,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
                class={
                  "w-10 h-10 rounded-lg flex items-center justify-center font-semibold text-white transition shadow-sm select-none " +
                  (initial().length >= 3 ? "text-[11px] " : "text-[13px] ") +
                  (isActive()
                    ? "ring-2 ring-indigo-500 ring-offset-2 ring-offset-neutral-950"
                    : unread()
                      ? "ring-2 ring-amber-400 ring-offset-2 ring-offset-neutral-950 opacity-100"
                      : "opacity-85 hover:opacity-100 hover:scale-[1.03]")
                }
                style={{
                  "background-color": color(),
                  opacity: isDragging() ? 0.4 : undefined,
                  cursor: isDragging() ? "grabbing" : "pointer",
                }}
                title={`${label()}\n${proj.path}${openCount() > 0 ? `\n${openCount()} open tab(s)` : ""}\n\nClick: open. Hold + drag: reorder. Right-click: more.`}
              >
                {initial()}
              </button>
              <Show when={openCount() > 0}>
                <span class="absolute -bottom-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full bg-green-500 text-[10px] font-bold text-neutral-950 flex items-center justify-center px-1 border-2 border-neutral-950 pointer-events-none">
                  {openCount()}
                </span>
              </Show>
              <Show when={unread() && !isActive()}>
                <span
                  class="absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full bg-amber-400 border-2 border-neutral-950 pointer-events-none"
                  aria-label="Claude finished a task in this project"
                />
              </Show>
              <button
                class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-neutral-800 text-neutral-300 hover:bg-red-600 hover:text-white border border-neutral-950 flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                title="Close project (still in history)"
                onClick={(e) => {
                  e.stopPropagation();
                  void requestClose(proj.path);
                }}
              >
                <X size={9} strokeWidth={3} />
              </button>
            </div>
          );
        }}
      </For>
      <button
        class="w-10 h-10 rounded-lg border border-dashed border-neutral-700 text-neutral-500 hover:border-neutral-500 hover:text-neutral-200 flex items-center justify-center transition"
        title="Add project"
        onClick={handleAdd}
      >
        <Plus size={18} strokeWidth={2} />
      </button>
      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            open={true}
            x={m().x}
            y={m().y}
            items={menuItemsFor(m().path)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
      <Show when={renaming()}>
        {(r) => (
          <RenameInitialsDialog
            projectPath={r().path}
            value={r().value}
            onChange={(v) => setRenaming({ path: r().path, value: v })}
            onCancel={() => setRenaming(null)}
            onConfirm={() => {
              projects.setCustomInitials(r().path, r().value);
              setRenaming(null);
            }}
            onClear={() => {
              projects.setCustomInitials(r().path, "");
              setRenaming(null);
            }}
          />
        )}
      </Show>
    </nav>
  );

  function menuItemsFor(path: string): ContextMenuItem[] {
    return [
      {
        kind: "action",
        label: "Rename initials…",
        icon: Pencil,
        onClick: () => {
          const current = projects.list.find((p) => p.path === path);
          setRenaming({
            path,
            value: current?.customInitials ?? projectInitial(path),
          });
        },
      },
      { kind: "divider" },
      {
        kind: "action",
        label: "Close project",
        icon: X,
        onClick: () => requestClose(path),
      },
    ];
  }
}

function RenameInitialsDialog(props: {
  projectPath: string;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onClear: () => void;
}) {
  let inputRef!: HTMLInputElement;
  onMount(() => {
    inputRef.focus();
    inputRef.select();
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      props.onConfirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    }
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div class="bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl w-[320px] p-4">
        <div class="text-[13px] text-neutral-200 font-medium mb-1">
          Rename initials
        </div>
        <div class="text-[11px] text-neutral-500 mb-3 truncate" title={props.projectPath}>
          {projectLabel(props.projectPath)}
        </div>
        <input
          ref={inputRef}
          type="text"
          maxLength={MAX_CUSTOM_INITIALS}
          value={props.value}
          onInput={(e) => props.onChange(e.currentTarget.value.toUpperCase())}
          onKeyDown={onKey}
          placeholder="e.g. PT"
          class="w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded text-[14px] text-neutral-100 text-center uppercase tracking-wider focus:outline-none focus:border-indigo-500"
        />
        <div class="text-[10px] text-neutral-500 mt-1.5">
          Up to {MAX_CUSTOM_INITIALS} characters. Leave empty and press
          “Reset” to restore the auto-generated initials.
        </div>
        <div class="flex justify-between items-center gap-2 mt-4">
          <button
            class="px-2.5 py-1.5 text-[12px] text-neutral-400 hover:text-neutral-200 transition"
            onClick={props.onClear}
          >
            Reset
          </button>
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-[12px] text-neutral-300 hover:bg-neutral-800 rounded transition"
              onClick={props.onCancel}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-[12px] bg-indigo-600 hover:bg-indigo-500 text-white rounded transition"
              onClick={props.onConfirm}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
