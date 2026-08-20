import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  GitMerge,
} from "lucide-solid";
import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useDiffPanel } from "@/context/diff-panel";
import { useGit } from "@/context/git";
import { commitTime } from "@/lib/relative-time";
import type { CommitDetail, DiffSource } from "@/lib/git-status";
import { DiffFileRow } from "./diff-file-row";
import { DiffStyleToggle } from "./diff-style-toggle";

/** How tall a commit message gets before it is cut off, roughly seven lines.
 *  A squash merge's message can run dozens of lines, and letting it size
 *  itself pushes the file list — the thing you opened the tab for — off the
 *  bottom of the panel. */
const BODY_COLLAPSED_PX = 132;

/** Ceiling on the expanded message, so "show more" reveals the text without
 *  handing the whole panel back to it. Past this it scrolls on its own. */
const BODY_EXPANDED_VH = 40;

/** One commit: its message, and the files it changed rendered through the
 *  same rows and the same `@pierre/diffs` instance the working-tree view
 *  uses. The only difference is which two blobs each row asks for. */
export function CommitTab(props: { projectPath: string; sha: string }) {
  const panel = useDiffPanel();
  const git = useGit();

  const [detail, setDetail] = createSignal<CommitDetail | null>(null);
  const [failed, setFailed] = createSignal(false);

  // Plain signals rather than createResource: reading an errored resource
  // re-throws, and this tab wants to render "couldn't read this commit"
  // itself rather than take the whole panel down with it.
  createEffect(
    on(
      () => ({ project: props.projectPath, sha: props.sha }),
      ({ project, sha }) => {
        setDetail(null);
        setFailed(false);
        let stale = false;
        onCleanup(() => {
          stale = true;
        });
        git
          .fetchCommitDetail(project, sha)
          .then((d) => {
            if (!stale) setDetail(d);
          })
          .catch((err) => {
            console.warn("commit detail failed", err);
            if (!stale) setFailed(true);
          });
      },
    ),
  );

  const source = (): DiffSource => ({ kind: "commit", sha: props.sha });

  /** Expansion is keyed globally by path, and the same file appears in many
   *  commits — without the sha, opening `git.rs` here would also open it in
   *  the working-tree list and in every other commit tab. */
  const keyFor = (path: string) => `${props.sha}:${path}`;

  const [bodyOpen, setBodyOpen] = createSignal(false);
  const [bodyClipped, setBodyClipped] = createSignal(false);
  let bodyRef: HTMLParagraphElement | undefined;
  let headerRef: HTMLDivElement | undefined;

  /** Whether the message is actually taller than the cut-off. Measured rather
   *  than guessed from its length: the panel is resizable, so the same text
   *  wraps to a different number of lines at different widths, and a
   *  character count would show the toggle on messages that fit. */
  function measureBody() {
    if (!bodyRef) {
      setBodyClipped(false);
      return;
    }
    const clipped = bodyRef.scrollHeight > BODY_COLLAPSED_PX + 1;
    setBodyClipped(clipped);
    // Widening the panel can make a message fit that didn't. Leaving it
    // "expanded" then strands it at the taller cap with no toggle to undo it.
    if (!clipped) setBodyOpen(false);
  }

  // Re-measure when the commit changes (new text) and when the panel is
  // dragged wider or narrower (same text, different line count).
  createEffect(on(detail, () => queueMicrotask(measureBody)));
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureBody());
    if (headerRef) ro.observe(headerRef);
    onCleanup(() => ro.disconnect());
  });

  const files = () => detail()?.files ?? [];
  const anyExpanded = () => files().some((f) => panel.isExpanded(keyFor(f.path)));

  function toggleAll() {
    // Not expandAll/collapseAll: those replace the whole expansion set, so
    // folding this commit would also fold the working-tree list behind it.
    panel.setManyExpanded(files().map((f) => keyFor(f.path)), !anyExpanded());
  }

  return (
    <div class="h-full flex flex-col">
      <Show
        when={detail()}
        fallback={
          <div class="h-full w-full flex items-center justify-center text-[12px] text-neutral-500">
            {failed() ? "Couldn't read this commit." : "Reading commit…"}
          </div>
        }
      >
        {(d) => (
          <>
            <div
              ref={headerRef}
              class="shrink-0 border-b border-neutral-800 px-3 py-2.5 flex flex-col gap-1.5"
            >
              <div class="flex items-start gap-2">
                <span class="text-[12px] text-neutral-100 leading-snug">
                  {d().subject || "(no message)"}
                </span>
                <span class="ml-auto shrink-0 text-[10px] font-mono text-neutral-500">
                  {d().short_sha}
                </span>
              </div>
              <div class="flex items-center gap-2 text-[10px] text-neutral-500">
                <span class="truncate">{d().author}</span>
                <span class="shrink-0">·</span>
                <span class="shrink-0">{commitTime(d().timestamp)}</span>
                <Show when={d().parent_count > 1}>
                  <span
                    class="shrink-0 flex items-center gap-1 text-neutral-500"
                    title="Shown against the first parent, as git show does"
                  >
                    <GitMerge size={10} strokeWidth={2} />
                    merge
                  </span>
                </Show>
              </div>
              <Show when={d().body}>
                {(body) => (
                  <div class="flex flex-col items-start">
                    <div class="relative w-full">
                      <p
                        ref={bodyRef}
                        class="text-[11px] text-neutral-400 whitespace-pre-wrap leading-relaxed"
                        style={
                          bodyOpen()
                            ? {
                                "max-height": `${BODY_EXPANDED_VH}vh`,
                                "overflow-y": "auto",
                              }
                            : {
                                "max-height": `${BODY_COLLAPSED_PX}px`,
                                overflow: "hidden",
                              }
                        }
                      >
                        {body()}
                      </p>
                      {/* Fades the cut edge instead of slicing a line in
                          half, so it reads as "there is more" rather than as
                          a rendering glitch. */}
                      <Show when={bodyClipped() && !bodyOpen()}>
                        <div class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-neutral-950 to-transparent" />
                      </Show>
                    </div>
                    <Show when={bodyClipped()}>
                      <button
                        onClick={() => setBodyOpen((v) => !v)}
                        class="mt-1 flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300 transition"
                      >
                        <Show
                          when={bodyOpen()}
                          fallback={<ChevronDown size={10} strokeWidth={2} />}
                        >
                          <ChevronUp size={10} strokeWidth={2} />
                        </Show>
                        {bodyOpen() ? "Show less" : "Show full message"}
                      </button>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
            <div class="h-9 shrink-0 border-b border-neutral-800 flex items-center gap-2 px-3">
              <span class="text-[11px] font-mono text-neutral-500">
                {d().files.length} file{d().files.length === 1 ? "" : "s"}
              </span>
              <span class="text-[11px] font-mono flex items-center gap-1.5">
                <span class="text-emerald-400">+{d().adds}</span>
                <span class="text-rose-400">−{d().dels}</span>
              </span>
              <div class="flex-1" />
              <DiffStyleToggle />
              <button
                onClick={toggleAll}
                class="w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
                title={anyExpanded() ? "Collapse all" : "Expand all"}
              >
                <Show
                  when={anyExpanded()}
                  fallback={<ChevronsUpDown size={13} strokeWidth={2} />}
                >
                  <ChevronsDownUp size={13} strokeWidth={2} />
                </Show>
              </button>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto">
              <Show
                when={d().files.length > 0}
                fallback={
                  <div class="h-full w-full flex items-center justify-center px-6 text-center text-[12px] text-neutral-500">
                    {d().parent_count > 1
                      ? "Nothing changed relative to the first parent."
                      : "This commit changed no files."}
                  </div>
                }
              >
                <For each={d().files}>
                  {(status) => (
                    <DiffFileRow
                      projectPath={props.projectPath}
                      status={status}
                      source={source()}
                      expandKey={keyFor(status.path)}
                    />
                  )}
                </For>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
