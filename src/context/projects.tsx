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

  function touch(path: string): void {
    const now = Date.now();
    setState(
      "list",
      produce((list: RecentProject[]) => {
        const idx = list.findIndex((p) => p.path === path);
        if (idx >= 0) list.splice(idx, 1);
        list.unshift({ path, lastOpened: now });
        if (list.length > MAX_RECENT_PROJECTS) {
          list.length = MAX_RECENT_PROJECTS;
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

  return {
    get list(): RecentProject[] {
      return state.list;
    },
    touch,
    remove,
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
