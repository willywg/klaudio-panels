import { ChevronsDownUp, ChevronsUpDown, X } from "lucide-solid";
import { createMemo, For, Show } from "solid-js";
import { useDiffPanel } from "@/context/diff-panel";
import { useGit } from "@/context/git";
import { DiffFileRow } from "./diff-file-row";

type Props = {
  projectPath: string;
};

export function DiffPanel(props: Props) {
  const panel = useDiffPanel();
  const git = useGit();

  const statuses = createMemo(() => git.statusFor(props.projectPath));
  const summary = () => git.summaryFor(props.projectPath);

  const anyExpanded = () =>
    statuses().some((s) => panel.isExpanded(s.path));

  function toggleAll() {
    if (anyExpanded()) {
      panel.collapseAll();
    } else {
      panel.expandAll(statuses().map((s) => s.path));
    }
  }

  return (
    <div class="h-full flex flex-col bg-neutral-950 border-l border-neutral-800">
      <div class="h-10 shrink-0 border-b border-neutral-800 flex items-center gap-2 px-3 bg-neutral-950">
        <span class="text-[12px] text-neutral-300 font-medium">
          Git changes
        </span>
        <span class="text-[11px] font-mono text-neutral-500">
          {statuses().length} file{statuses().length === 1 ? "" : "s"}
        </span>
        <span class="ml-1 text-[11px] font-mono flex items-center gap-1.5">
          <span class="text-emerald-400">+{summary().adds}</span>
          <span class="text-rose-400">−{summary().dels}</span>
        </span>
        <div class="flex-1" />
        <div
          class="flex items-center rounded border border-neutral-800 overflow-hidden text-[11px]"
          role="group"
        >
          <button
            onClick={() => panel.setDiffStyle("unified")}
            class={
              "px-2 h-6 transition " +
              (panel.diffStyle() === "unified"
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:text-neutral-200")
            }
            title="Unified diff"
          >
            Unified
          </button>
          <button
            onClick={() => panel.setDiffStyle("split")}
            class={
              "px-2 h-6 transition border-l border-neutral-800 " +
              (panel.diffStyle() === "split"
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:text-neutral-200")
            }
            title="Split diff"
          >
            Split
          </button>
        </div>
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
        <button
          onClick={() => panel.close()}
          class="w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
          title="Close diff panel (⌘⇧D)"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto">
        <Show
          when={statuses().length > 0}
          fallback={
            <div class="h-full w-full flex items-center justify-center text-[12px] text-neutral-500">
              No changes in working directory.
            </div>
          }
        >
          <For each={statuses()}>
            {(status) => (
              <DiffFileRow projectPath={props.projectPath} status={status} />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
