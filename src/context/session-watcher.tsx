import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTerminal } from "@/context/terminal";
import { setLastSessionId } from "@/components/last-session";
import { displayLabel } from "@/lib/session-label";
import type { SessionMeta } from "@/components/sessions-list";

type SessionNewPayload = {
  project_path: string;
  session_id: string;
  jsonl_created_at_ms: number;
  preview: string | null;
};

const SANITY_GUARD_MS = 30_000;

function makeSessionWatcherContext() {
  const term = useTerminal();
  const [metaBump, setMetaBump] = createSignal(0);
  const unlistens: UnlistenFn[] = [];

  onMount(async () => {
    try {
      unlistens.push(
        await listen<SessionNewPayload>("session:new", (e) => {
          const { project_path, session_id, jsonl_created_at_ms, preview } = e.payload;
          // Skip if a tab already has this sessionId (existing resume).
          if (term.store.tabs.some((t) => t.sessionId === session_id)) return;

          // FIFO: oldest pending "new" tab for this project, with 30s sanity guard.
          const candidate = term.store.tabs
            .filter(
              (t) =>
                t.projectPath === project_path &&
                t.sessionId === null &&
                jsonl_created_at_ms + SANITY_GUARD_MS >= t.spawnedAt,
            )
            .sort((a, b) => a.spawnedAt - b.spawnedAt)[0];
          if (!candidate) return;

          term.promoteTab(candidate.id, session_id, preview);
          setLastSessionId(project_path, session_id);
          setMetaBump((k) => k + 1);
        }),
      );

      unlistens.push(
        await listen<SessionMeta>("session:meta", (e) => {
          const meta = e.payload;
          const tab = term.store.tabs.find((t) => t.sessionId === meta.id);
          if (tab) {
            term.setTabLabel(tab.id, displayLabel(meta));
          }
          setMetaBump((k) => k + 1);
        }),
      );
    } catch (err) {
      console.warn("session-watcher listen failed", err);
    }
  });

  onCleanup(() => {
    for (const fn of unlistens) fn();
  });

  return {
    metaBump: metaBump as Accessor<number>,
  };
}

const Ctx = createContext<ReturnType<typeof makeSessionWatcherContext>>();

export function SessionWatcherProvider(props: ParentProps) {
  const ctx = makeSessionWatcherContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useSessionWatcher() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSessionWatcher outside SessionWatcherProvider");
  return v;
}
