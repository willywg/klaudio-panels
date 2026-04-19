import {
  createContext,
  createMemo,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  type RecentProject,
  loadRecentProjects,
  saveRecentProjects,
  MAX_RECENT_PROJECTS,
} from "@/lib/recent-projects";

type State = {
  list: RecentProject[];
};

function makeProjectsContext() {
  const [state, setState] = createStore<State>({
    list: loadRecentProjects(),
  });

  const pinned: Accessor<RecentProject[]> = createMemo(() =>
    state.list.filter((p) => p.pinned),
  );

  /** Idempotent insert by path. Always ensures `pinned: true` (re-pins if the
   *  project was previously unpinned). New entries are appended at the END. */
  function touch(path: string): void {
    const now = Date.now();
    setState(
      "list",
      produce((list: RecentProject[]) => {
        const idx = list.findIndex((p) => p.path === path);
        if (idx >= 0) {
          list[idx].lastOpened = now;
          list[idx].pinned = true;
        } else {
          list.push({ path, lastOpened: now, pinned: true });
          if (list.length > MAX_RECENT_PROJECTS) {
            // Drop the oldest by lastOpened — never the user's pinned entries
            // unless the ceiling is full AND all are pinned.
            let oldestIdx = 0;
            let oldestTs = list[0].lastOpened;
            for (let i = 1; i < list.length; i++) {
              if (list[i].lastOpened < oldestTs) {
                oldestTs = list[i].lastOpened;
                oldestIdx = i;
              }
            }
            list.splice(oldestIdx, 1);
          }
        }
      }),
    );
    saveRecentProjects(state.list);
  }

  /** Remove from the sidebar but keep it in history (Home still shows it). */
  function unpin(path: string): void {
    setState(
      "list",
      produce((list: RecentProject[]) => {
        const idx = list.findIndex((p) => p.path === path);
        if (idx >= 0) list[idx].pinned = false;
      }),
    );
    saveRecentProjects(state.list);
  }

  /** Full removal from history (sidebar + Home). */
  function remove(path: string): void {
    setState(
      "list",
      produce((list: RecentProject[]) => {
        const idx = list.findIndex((p) => p.path === path);
        if (idx >= 0) list.splice(idx, 1);
      }),
    );
    saveRecentProjects(state.list);
  }

  /** Reorder: drop `fromPath` relative to `toPath`, Slack-style.
   *   - Drag DOWN (fromIdx < toIdx): drops AFTER the target.
   *   - Drag UP   (fromIdx > toIdx): drops BEFORE the target.
   *  After splicing out `fromPath`, the target index shifts by -1 when
   *  dragging down; using the raw `toIdx` for the insert position yields the
   *  desired "after" placement. When dragging up the target index is
   *  unchanged and `toIdx` places the item before it. */
  function reorder(fromPath: string, toPath: string): void {
    if (fromPath === toPath) return;
    setState(
      "list",
      produce((list: RecentProject[]) => {
        const fromIdx = list.findIndex((p) => p.path === fromPath);
        const toIdx = list.findIndex((p) => p.path === toPath);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = list.splice(fromIdx, 1);
        list.splice(toIdx, 0, moved);
      }),
    );
    saveRecentProjects(state.list);
  }

  return {
    get list(): RecentProject[] {
      return state.list;
    },
    get pinned(): RecentProject[] {
      return pinned();
    },
    touch,
    unpin,
    remove,
    reorder,
  };
}

const Ctx = createContext<ReturnType<typeof makeProjectsContext>>();

export function ProjectsProvider(props: ParentProps) {
  const ctx = makeProjectsContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useProjects() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects outside ProjectsProvider");
  return v;
}
