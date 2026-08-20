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
  CommitDetail,
  CommitInfo,
  DiffPayload,
  DiffSource,
  FileStatus,
  GitSummary,
  HistoryPayload,
  RepoInfo,
  StatusPayload,
} from "@/lib/git-status";

type ProjectGitState = {
  status: FileStatus[];
  repos: RepoInfo[];
  summary: GitSummary;
  loading: boolean;
  lastFetch: number;
};

type GitStore = Record<string, ProjectGitState>;

type ProjectHistoryState = {
  commits: CommitInfo[];
  branch: string | null;
  ahead: number | null;
  hasMore: boolean;
  loading: boolean;
  /** Message from the backend — "not a git repository" is the common one,
   *  and swallowing it leaves the History tab looking merely empty. */
  error: string | null;
  /** A first page has been asked for. Distinguishes "no commits" from
   *  "nobody has opened History yet", which decides whether an fs event
   *  should refetch. */
  loaded: boolean;
};

/** Commits per page, and the increment "Load more" adds. */
const HISTORY_PAGE = 30;

/** Commit details held at once. A commit is immutable, so a cached detail can
 *  never go stale — the cap is about memory, not freshness. */
const MAX_CACHED_DETAILS = 50;

const EMPTY_SUMMARY: GitSummary = {
  file_count: 0,
  adds: 0,
  dels: 0,
  branch: null,
};

const REFRESH_DEBOUNCE_MS = 300;

const EMPTY_HISTORY: ProjectHistoryState = Object.freeze({
  commits: [],
  branch: null,
  ahead: null,
  hasMore: false,
  loading: false,
  error: null,
  loaded: false,
}) as ProjectHistoryState;

function emptyState(): ProjectGitState {
  return {
    status: [],
    repos: [],
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

function emptyHistory(): ProjectHistoryState {
  return {
    commits: [],
    branch: null,
    ahead: null,
    hasMore: false,
    loading: false,
    error: null,
    loaded: false,
  };
}

function makeGitContext() {
  const [store, setStore] = createStore<GitStore>({});
  const [history, setHistory] = createStore<Record<string, ProjectHistoryState>>(
    {},
  );
  const details = new Map<string, CommitDetail>();
  const unlisteners = new Map<string, UnlistenFn>();
  const timers = new Map<string, number>();

  async function fetchNow(projectPath: string) {
    setStore(projectPath, "loading", true);
    try {
      // One call, not two: the summary is a fold over this same file list,
      // and asking for it separately re-walked every repo in the project.
      const status = await invoke<StatusPayload>("git_status", { projectPath });
      setStore(
        projectPath,
        produce((s: ProjectGitState) => {
          s.status = status.files;
          s.repos = status.repos;
          s.summary = status.summary;
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
      // A commit changes no file in the working tree, so the History list
      // would otherwise sit on the pre-commit page until manually refreshed —
      // which is the exact moment the user wants to look at it.
      void refreshHistory(projectPath);
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

  /** Repos that contributed to the last status — the project plus any nested
   *  repo. Consumed by the panel to label each group with its branch. */
  function reposFor(projectPath: string): RepoInfo[] {
    return store[projectPath]?.repos ?? [];
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
    source: DiffSource = { kind: "worktree" },
  ): Promise<DiffPayload> {
    if (source.kind === "commit") {
      return invoke<DiffPayload>("git_diff_commit_file", {
        projectPath,
        sha: source.sha,
        relPath,
      });
    }
    return invoke<DiffPayload>("git_diff_file", {
      projectPath,
      relPath,
    });
  }

  function historyFor(projectPath: string): ProjectHistoryState {
    return history[projectPath] ?? EMPTY_HISTORY;
  }

  /** Fetch `count` commits from the top, replacing what's there.
   *
   *  Always a single call rather than one per page appended: a refetch after
   *  a commit has to re-anchor the whole list anyway (everything shifted by
   *  one), and re-requesting the same count is what keeps a user who pressed
   *  "Load more" three times from being snapped back to page one. */
  async function fetchHistory(projectPath: string, count: number) {
    setHistory(projectPath, "loading", true);
    try {
      const payload = await invoke<HistoryPayload>("git_history", {
        projectPath,
        skip: 0,
        limit: count,
      });
      setHistory(
        projectPath,
        produce((h: ProjectHistoryState) => {
          h.commits = payload.commits;
          h.branch = payload.branch;
          h.ahead = payload.ahead;
          h.hasMore = payload.has_more;
          h.loading = false;
          h.loaded = true;
          h.error = null;
        }),
      );
    } catch (err) {
      setHistory(
        projectPath,
        produce((h: ProjectHistoryState) => {
          h.loading = false;
          h.loaded = true;
          h.error = String(err);
        }),
      );
    }
  }

  /** First page, unless one is already loaded. Called when History opens. */
  async function loadHistory(projectPath: string): Promise<void> {
    if (!history[projectPath]) setHistory(projectPath, emptyHistory());
    if (history[projectPath].loaded || history[projectPath].loading) return;
    await fetchHistory(projectPath, HISTORY_PAGE);
  }

  async function loadMoreCommits(projectPath: string): Promise<void> {
    const current = history[projectPath];
    if (!current || current.loading || !current.hasMore) return;
    await fetchHistory(projectPath, current.commits.length + HISTORY_PAGE);
  }

  /** Re-read what's already on screen. No-op until History has been opened,
   *  so projects whose panel never left Changes pay nothing per fs event. */
  async function refreshHistory(projectPath: string): Promise<void> {
    const current = history[projectPath];
    if (!current?.loaded || current.loading) return;
    await fetchHistory(
      projectPath,
      Math.max(HISTORY_PAGE, current.commits.length),
    );
  }

  async function fetchCommitDetail(
    projectPath: string,
    sha: string,
  ): Promise<CommitDetail> {
    const key = `${projectPath}\u0000${sha}`;
    const hit = details.get(key);
    if (hit) return hit;
    const detail = await invoke<CommitDetail>("git_commit_detail", {
      projectPath,
      sha,
    });
    if (details.size >= MAX_CACHED_DETAILS) {
      const oldest = details.keys().next().value;
      if (oldest !== undefined) details.delete(oldest);
    }
    details.set(key, detail);
    return detail;
  }

  /** Manual refetch of git_status + git_summary. Skips if a fetch is already
   *  in flight (the in-flight call already produces fresh data on completion).
   *  Used by the Git changes panel header refresh button — needed because
   *  some external commits (`git commit` from another process, `opencommit`,
   *  etc.) only touch `.git/` internals that our fs-watcher's `is_relevant`
   *  filter drops on purpose to avoid debouncer spam. */
  async function refresh(projectPath: string): Promise<void> {
    if (store[projectPath]?.loading) return;
    await fetchNow(projectPath);
  }

  onCleanup(() => {
    for (const [, un] of unlisteners) un();
    for (const [, t] of timers) window.clearTimeout(t);
    unlisteners.clear();
    timers.clear();
  });

  return {
    ensureFor,
    refresh,
    statusFor,
    summaryFor,
    reposFor,
    statusByAbsPath,
    fetchDiff,
    store,
    // History
    historyFor,
    loadHistory,
    loadMoreCommits,
    refreshHistory,
    fetchCommitDetail,
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
