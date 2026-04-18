import {
  createContext,
  useContext,
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

  /** Idempotent insert by path. If new, appends at the END (insertion order).
   *  If existing, only updates `lastOpened` without changing position. */
  function touch(path: string): void {
    const now = Date.now();
    setState(
      "list",
      produce((list: RecentProject[]) => {
        const idx = list.findIndex((p) => p.path === path);
        if (idx >= 0) {
          list[idx].lastOpened = now;
        } else {
          list.push({ path, lastOpened: now });
          if (list.length > MAX_RECENT_PROJECTS) {
            // Drop the OLDEST-used entry (lowest lastOpened), not the first
            // in insertion order — keep the user's curated sequence.
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

  /** Move the project identified by `fromPath` to occupy the slot currently
   *  held by `toPath`. Position of other items shifts accordingly. */
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
    touch,
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
