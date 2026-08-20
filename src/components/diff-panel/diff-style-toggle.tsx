import { useDiffPanel } from "@/context/diff-panel";

/** Unified / Split picker. One global setting, so it appears wherever diffs
 *  are on screen — the working-tree list and any commit tab — rather than
 *  making you navigate back to the one header that owned it. */
export function DiffStyleToggle() {
  const panel = useDiffPanel();
  const cls = (active: boolean, extra = "") =>
    "px-2 h-5 transition " +
    extra +
    (active
      ? "bg-neutral-800 text-neutral-100"
      : "text-neutral-400 hover:text-neutral-200");

  return (
    <div
      class="flex items-center rounded border border-neutral-800 overflow-hidden text-[11px]"
      role="group"
    >
      <button
        onClick={() => panel.setDiffStyle("unified")}
        class={cls(panel.diffStyle() === "unified")}
        title="Unified diff"
      >
        Unified
      </button>
      <button
        onClick={() => panel.setDiffStyle("split")}
        class={cls(panel.diffStyle() === "split", "border-l border-neutral-800 ")}
        title="Split diff"
      >
        Split
      </button>
    </div>
  );
}
