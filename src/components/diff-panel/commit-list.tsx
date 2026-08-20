import { ArrowUpFromLine, GitMerge } from "lucide-solid";
import { createEffect, For, on, Show } from "solid-js";
import { useDiffPanel } from "@/context/diff-panel";
import { useGit } from "@/context/git";
import { commitTime } from "@/lib/relative-time";
import type { CommitInfo } from "@/lib/git-status";

/** The History half of the git tab: this branch's commits, newest first.
 *
 *  Clicking one opens it in its own tab rather than replacing the list —
 *  reviewing a commit usually means looking at two, and a master-detail view
 *  in a 640px panel makes you walk back and forth to do it. */
export function CommitList(props: { projectPath: string }) {
  const panel = useDiffPanel();
  const git = useGit();
  const state = () => git.historyFor(props.projectPath);

  // Fetching on mount would miss the project switch, since the panel keeps
  // one CommitList alive and swaps the path underneath it. The dependency is
  // spelled out because `loadHistory` reads the store to decide whether to
  // fetch — tracking those reads would re-run this on its own writes.
  createEffect(
    on(
      () => props.projectPath,
      (path) => void git.loadHistory(path),
    ),
  );

  return (
    <div class="flex-1 min-h-0 overflow-y-auto">
      <Show when={state().error}>
        {(err) => (
          <div class="h-full w-full flex flex-col items-center justify-center gap-1 px-6 text-center">
            <span class="text-[12px] text-neutral-400">
              Can't read this project's history.
            </span>
            <span class="text-[11px] font-mono text-neutral-600 break-all">
              {err()}
            </span>
          </div>
        )}
      </Show>
      <Show when={!state().error}>
        <Show
          when={state().commits.length > 0}
          fallback={
            <div class="h-full w-full flex items-center justify-center text-[12px] text-neutral-500">
              {state().loading ? "Reading history…" : "No commits yet."}
            </div>
          }
        >
          <Show when={(state().ahead ?? 0) > 0}>
            <div class="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-neutral-900 border-b border-neutral-800">
              <ArrowUpFromLine
                size={11}
                strokeWidth={2}
                class="shrink-0 text-amber-400"
              />
              <span class="text-[11px] text-amber-300/90">
                {state().ahead} commit{state().ahead === 1 ? "" : "s"} not
                pushed yet
              </span>
            </div>
          </Show>
          <For each={state().commits}>
            {(commit) => (
              <CommitRow
                commit={commit}
                onOpen={() =>
                  panel.openCommit(
                    props.projectPath,
                    commit.sha,
                    commit.subject,
                  )
                }
              />
            )}
          </For>
          <Show when={state().hasMore}>
            <div class="p-3">
              <button
                onClick={() => void git.loadMoreCommits(props.projectPath)}
                disabled={state().loading}
                class="w-full h-7 rounded border border-neutral-800 text-[11px] text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition disabled:opacity-50"
              >
                {state().loading ? "Loading…" : "Load more"}
              </button>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function CommitRow(props: { commit: CommitInfo; onOpen: () => void }) {
  const c = () => props.commit;
  return (
    <button
      onClick={props.onOpen}
      class="w-full flex flex-col gap-0.5 px-3 py-2 text-left border-b border-neutral-800/80 hover:bg-neutral-900/60 transition"
    >
      <div class="w-full flex items-center gap-2">
        {/* An unpushed commit is the whole reason this view exists: Claude
            commits, the Changes list empties, and without this dot there is
            nothing on screen saying the work is still only local. */}
        <span
          class={
            "shrink-0 w-1.5 h-1.5 rounded-full " +
            (c().unpushed ? "bg-amber-400" : "bg-transparent")
          }
          title={c().unpushed ? "Not pushed yet" : undefined}
        />
        <span class="shrink-0 text-[10px] font-mono text-neutral-500">
          {c().short_sha}
        </span>
        <span class="text-[12px] text-neutral-200 truncate">
          {c().subject || "(no message)"}
        </span>
        <span class="ml-auto shrink-0 text-[10px] font-mono flex items-center gap-1.5">
          {/* A merge's first-parent stats restate every commit it brought in,
              so the count would describe the branch rather than the merge.
              `git log --stat` omits them for the same reason. */}
          <Show
            when={c().stats}
            fallback={
              <span class="flex items-center gap-1 text-neutral-600">
                <GitMerge size={10} strokeWidth={2} />
                merge
              </span>
            }
          >
            {(stats) => (
              <>
                <span class="text-emerald-400">+{stats().adds}</span>
                <span class="text-rose-400">−{stats().dels}</span>
              </>
            )}
          </Show>
        </span>
      </div>
      <div class="w-full flex items-center gap-2 pl-[14px] text-[10px] text-neutral-500">
        <span class="truncate">{c().author}</span>
        <span class="shrink-0">·</span>
        <span class="shrink-0">{commitTime(c().timestamp)}</span>
        <Show when={c().stats}>
          {(stats) => (
            <span class="ml-auto shrink-0">
              {stats().files} file{stats().files === 1 ? "" : "s"}
            </span>
          )}
        </Show>
      </div>
    </button>
  );
}
