import {
  createContext,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DiffPayload,
  FileStatus,
  GitSummary,
} from "@/lib/git-status";

type ProjectGitState = {
  status: FileStatus[];
  summary: GitSummary;
  loading: boolean;
  lastFetch: number;
};

type GitStore = Record<string, ProjectGitState>;

const EMPTY_SUMMARY: GitSummary = {
  file_count: 0,
  adds: 0,
  dels: 0,
  branch: null,
};

const REFRESH_DEBOUNCE_MS = 300;

function emptyState(): ProjectGitState {
  return {
    status: [],
    summary: { ...EMPTY_SUMMARY },
    loading: false,
    lastFetch: 0,
  };
}

/** Normalize absolute paths to forward slashes so the Rust-side repo-relative
 *  paths and frontend tree paths line up on every platform. The file-tree
 *  stores paths exactly as Rust emitted them — on macOS that's already
 *  forward-slash. On Windows (future) we'd normalize here. */
function joinAbs(projectPath: string, rel: string): string {
  const base = projectPath.endsWith("/") ? projectPath.slice(0, -1) : projectPath;
  return `${base}/${rel}`;
}

function makeGitContext() {
  const [store, setStore] = createStore<GitStore>({});
  const unlisteners = new Map<string, UnlistenFn>();
  const timers = new Map<string, number>();

  async function fetchNow(projectPath: string) {
    setStore(projectPath, "loading", true);
    try {
      const [status, summary] = await Promise.all([
        invoke<FileStatus[]>("git_status", { projectPath }),
        invoke<GitSummary>("git_summary", { projectPath }),
      ]);
      setStore(
        projectPath,
        produce((s: ProjectGitState) => {
          s.status = status;
          s.summary = summary;
          s.loading = false;
          s.lastFetch = Date.now();
        }),
      );
    } catch (err) {
      console.warn("git fetch failed", err);
      setStore(projectPath, "loading", false);
    }
  }

  function scheduleRefetch(projectPath: string) {
    const prior = timers.get(projectPath);
    if (prior) window.clearTimeout(prior);
    const t = window.setTimeout(() => {
      timers.delete(projectPath);
      void fetchNow(projectPath);
    }, REFRESH_DEBOUNCE_MS);
    timers.set(projectPath, t);
  }

  async function ensureFor(projectPath: string) {
    if (store[projectPath]) return;
    setStore(projectPath, emptyState());
    try {
      const un = await listen<{ project_path: string }>("fs-event", (ev) => {
        if (ev.payload.project_path !== projectPath) return;
        scheduleRefetch(projectPath);
      });
      unlisteners.set(projectPath, un);
    } catch (err) {
      console.warn("git: failed to subscribe to fs events", err);
    }
    // watch_project is idempotent (fs.rs LRU dedup). We invoke here so badges
    // and pill refresh even if the user never opens the Files tab.
    try {
      await invoke("watch_project", { projectPath });
    } catch (err) {
      console.warn("git: watch_project failed", err);
    }
    await fetchNow(projectPath);
  }

  function statusFor(projectPath: string): FileStatus[] {
    return store[projectPath]?.status ?? [];
  }

  function summaryFor(projectPath: string): GitSummary {
    return store[projectPath]?.summary ?? EMPTY_SUMMARY;
  }

  /** Map repo-relative path → kind, keyed by absolute path so file-tree nodes
   *  (which use absolute paths) can look up their badge cheaply. */
  function statusByAbsPath(projectPath: string): Map<string, FileStatus> {
    const out = new Map<string, FileStatus>();
    const rows = store[projectPath]?.status ?? [];
    for (const row of rows) {
      out.set(joinAbs(projectPath, row.path), row);
    }
    return out;
  }

  async function fetchDiff(
    projectPath: string,
    relPath: string,
  ): Promise<DiffPayload> {
    return invoke<DiffPayload>("git_diff_file", {
      projectPath,
      relPath,
    });
  }

  onCleanup(() => {
    for (const [, un] of unlisteners) un();
    for (const [, t] of timers) window.clearTimeout(t);
    unlisteners.clear();
    timers.clear();
  });

  return {
    ensureFor,
    statusFor,
    summaryFor,
    statusByAbsPath,
    fetchDiff,
    store,
  };
}

const Ctx = createContext<ReturnType<typeof makeGitContext>>();

export function GitProvider(props: ParentProps) {
  const ctx = makeGitContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useGit() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGit outside GitProvider");
  return v;
}
