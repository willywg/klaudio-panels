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
import { useTerminal, type TerminalTab } from "@/context/terminal";
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

/** The backend's global JSONL watcher (session_watcher.rs) only observes
 *  the default `~/.claude/projects` root — a project pinned to a custom
 *  CLAUDE_CONFIG_DIR never produces these events for its own sessions (see
 *  CLAUDE.md decision #13's follow-up note). So a `session:new` payload can
 *  only ever legitimately describe a "default" profile tab; picking the
 *  oldest matching pending tab without this guard could hand a same-path
 *  default-profile session's id/preview to a custom-profile tab that's
 *  still waiting on its own (unwatched) JSONL to appear.
 *
 *  Exported so this filter — the actual cross-profile safety property —
 *  can be unit tested without standing up Tauri's event bus. */
export function findPromotionCandidate(
  tabs: readonly TerminalTab[],
  payload: Pick<SessionNewPayload, "project_path" | "jsonl_created_at_ms">,
): TerminalTab | undefined {
  return tabs
    .filter(
      (t) =>
        t.projectPath === payload.project_path &&
        t.profileId === "default" &&
        t.sessionId === null &&
        payload.jsonl_created_at_ms + SANITY_GUARD_MS >= t.spawnedAt,
    )
    .sort((a, b) => a.spawnedAt - b.spawnedAt)[0];
}

/** Same reasoning as `findPromotionCandidate`: a `session:meta` payload
 *  only ever describes a default-profile session, so it must never relabel
 *  a custom-profile tab even if the ids happened to coincide. */
export function shouldApplySessionMeta(tab: TerminalTab | undefined): boolean {
  return tab !== undefined && tab.profileId === "default";
}

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

          // FIFO: oldest pending "new" default-profile tab for this
          // project, with 30s sanity guard — see findPromotionCandidate.
          const candidate = findPromotionCandidate(term.store.tabs, {
            project_path,
            jsonl_created_at_ms,
          });
          if (!candidate) return;

          term.promoteTab(candidate.id, session_id, preview);
          // Safe by construction: findPromotionCandidate only ever returns
          // a "default" profile tab.
          setLastSessionId(project_path, "default", session_id);
          setMetaBump((k) => k + 1);
        }),
      );

      unlistens.push(
        await listen<SessionMeta>("session:meta", (e) => {
          const meta = e.payload;
          const tab = term.store.tabs.find((t) => t.sessionId === meta.id);
          if (shouldApplySessionMeta(tab)) {
            term.setTabLabel(tab!.id, displayLabel(meta));
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
