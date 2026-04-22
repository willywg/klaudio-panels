import { Show } from "solid-js";
import { useGit } from "@/context/git";
import { useDiffPanel } from "@/context/diff-panel";

type Props = {
  projectPath: string;
};

/** Warp-style `+N −M` indicator that lives in the titlebar. Click toggles the
 *  diff panel. Hidden when there are no changes. */
export function GitSummaryPill(props: Props) {
  const git = useGit();
  const panel = useDiffPanel();

  const summary = () => git.summaryFor(props.projectPath);
  const visible = () => summary().adds > 0 || summary().dels > 0;

  function onClick() {
    panel.toggle(props.projectPath);
  }

  return (
    <Show when={visible()}>
      <button
        onClick={onClick}
        class="h-6 px-2 rounded-md flex items-center gap-1.5 text-[11px] font-mono bg-neutral-900/70 border border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800 transition"
        title="Toggle diff panel (⌘⇧D)"
      >
        <span class="text-emerald-400">+{summary().adds}</span>
        <span class="text-neutral-700">·</span>
        <span class="text-rose-400">−{summary().dels}</span>
      </button>
    </Show>
  );
}
