import {
  createContext,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";
import {
  type RecentProject,
  loadRecentProjects,
  saveRecentProjects,
  MAX_RECENT_PROJECTS,
} from "@/lib/recent-projects";

function makeProjectsContext() {
  const [recents, setRecents] = createSignal<RecentProject[]>(
    loadRecentProjects(),
  );

  function touch(path: string): void {
    const now = Date.now();
    const filtered = recents().filter((p) => p.path !== path);
    const next = [{ path, lastOpened: now }, ...filtered].slice(
      0,
      MAX_RECENT_PROJECTS,
    );
    setRecents(next);
    saveRecentProjects(next);
  }

  function remove(path: string): void {
    const next = recents().filter((p) => p.path !== path);
    setRecents(next);
    saveRecentProjects(next);
  }

  return { recents, touch, remove };
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
