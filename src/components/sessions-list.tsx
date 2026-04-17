import { createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-solid";
import { displayLabel } from "@/lib/session-label";

export type SessionMeta = {
  id: string;
  timestamp: string | null;
  first_message_preview: string | null;
  custom_title: string | null;
  summary: string | null;
  project_path: string;
};

export function SessionsList(props: {
  projectPath: string;
  activeSessionId: string | null;
  openSessionIds: Set<string>;
  openingSessionIds: Set<string>;
  onNew: () => void;
  onSelect: (s: SessionMeta) => void;
  onRefresh: () => void;
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

      <div class="px-3 mb-1 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-neutral-500">
          Sesiones
        </span>
        <button
          class="p-1 text-neutral-500 hover:text-neutral-200 rounded transition"
          onClick={props.onRefresh}
          title="Refrescar lista"
        >
          <RefreshCw
            size={12}
            strokeWidth={2}
            class={sessions.loading ? "animate-spin" : ""}
          />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto">
        <Show when={sessions.loading && !sessions.latest}>
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
          {(s) => {
            const isActive = () => props.activeSessionId === s.id;
            const isOpen = () => props.openSessionIds.has(s.id);
            const isOpening = () => props.openingSessionIds.has(s.id);
            const label = () => displayLabel(s);
            return (
              <button
                onClick={() => !isOpening() && props.onSelect(s)}
                disabled={isOpening()}
                class={
                  "w-full text-left px-3 py-2 border-l-2 flex gap-2 items-start disabled:cursor-wait " +
                  (isActive()
                    ? "border-indigo-500 bg-neutral-900"
                    : isOpen()
                      ? "border-green-600/60 hover:bg-neutral-900/50"
                      : "border-transparent hover:bg-neutral-900/50")
                }
                title={isOpen() ? "Abierta en un tab" : undefined}
              >
                <span
                  class={
                    "mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 " +
                    (isOpening()
                      ? "bg-indigo-400 animate-pulse"
                      : isOpen()
                        ? "bg-green-500"
                        : "bg-transparent")
                  }
                />
                <span class="flex-1 min-w-0">
                  <div class="text-[11px] text-neutral-500 font-mono">
                    {formatTs(s.timestamp)}
                  </div>
                  <div class="text-xs text-neutral-200 line-clamp-2 mt-0.5">
                    {label()}
                  </div>
                </span>
              </button>
            );
          }}
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
