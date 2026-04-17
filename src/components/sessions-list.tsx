import { createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { SessionMeta } from "@/lib/claude-events";

export function SessionsList(props: {
  projectPath: string;
  activeSessionId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  refreshKey: number;
}) {
  const [sessions] = createResource(
    () => ({ path: props.projectPath, _k: props.refreshKey }),
    async ({ path }) => {
      return (await invoke("list_sessions_for_project", {
        projectPath: path,
      })) as SessionMeta[];
    },
  );

  return (
    <div class="h-full flex flex-col">
      <button
        class="m-3 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded text-sm font-medium"
        onClick={props.onNew}
      >
        + Nueva sesión
      </button>

      <div class="px-3 text-xs uppercase tracking-wider text-neutral-500 mb-1">
        Sesiones
      </div>

      <div class="flex-1 overflow-y-auto">
        <Show when={sessions.loading}>
          <div class="px-3 py-2 text-xs text-neutral-500">Cargando…</div>
        </Show>
        <Show when={sessions.error}>
          <div class="px-3 py-2 text-xs text-red-400">
            Error: {String(sessions.error)}
          </div>
        </Show>
        <Show when={sessions() && sessions()!.length === 0}>
          <div class="px-3 py-2 text-xs text-neutral-500">
            No hay sesiones previas para este proyecto.
          </div>
        </Show>

        <For each={sessions() ?? []}>
          {(s) => (
            <button
              onClick={() => props.onSelect(s.id)}
              class={
                "w-full text-left px-3 py-2 border-l-2 " +
                (props.activeSessionId === s.id
                  ? "border-indigo-500 bg-neutral-900"
                  : "border-transparent hover:bg-neutral-900/50")
              }
            >
              <div class="text-[11px] text-neutral-500 font-mono">
                {formatTs(s.timestamp)}
              </div>
              <div class="text-xs text-neutral-200 line-clamp-2 mt-0.5">
                {s.first_message_preview ?? "(sin contenido)"}
              </div>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function formatTs(ts: string | null): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  } catch {
    return ts;
  }
}
