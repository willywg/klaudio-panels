import { ChevronDown, ChevronRight } from "lucide-solid";
import { createEffect, on, onCleanup, Show } from "solid-js";
import { DIFFS_TAG_NAME, FileDiff } from "@pierre/diffs";
import { useDiffPanel, type DiffStyle } from "@/context/diff-panel";
import { useGit } from "@/context/git";
import {
  BADGE_COLOR,
  BADGE_LETTER,
  type FileStatus,
} from "@/lib/git-status";

type Props = {
  projectPath: string;
  status: FileStatus;
};

function basename(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(idx + 1) : rel;
}

function dirname(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(0, idx) : "";
}

export function DiffFileRow(props: Props) {
  let rowRef!: HTMLDivElement;
  let contentRef!: HTMLDivElement;
  let diffsEl: HTMLElement | undefined;
  let fd: FileDiff | undefined;
  let rendered = false;
  let lastStyle: DiffStyle | undefined;
  const panel = useDiffPanel();
  const git = useGit();

  const expanded = () => panel.isExpanded(props.status.path);

  function disposeDiff() {
    fd?.cleanUp();
    fd = undefined;
    if (diffsEl && diffsEl.parentNode) {
      diffsEl.parentNode.removeChild(diffsEl);
    }
    diffsEl = undefined;
    rendered = false;
    lastStyle = undefined;
  }

  function mountPlaceholder(message: string) {
    if (!contentRef) return;
    disposeDiff();
    const node = document.createElement("div");
    node.className = "px-4 py-4 text-[12px] text-neutral-500";
    node.textContent = message;
    contentRef.appendChild(node);
  }

  async function ensureRendered() {
    if (!contentRef) return;
    const style = panel.diffStyle();
    if (rendered && lastStyle === style) return;

    // Clear any prior content (diff or placeholder).
    while (contentRef.firstChild) {
      contentRef.removeChild(contentRef.firstChild);
    }
    disposeDiff();

    if (props.status.is_binary) {
      mountPlaceholder("Binary file — diff not rendered.");
      return;
    }

    const payload = await git.fetchDiff(props.projectPath, props.status.path);
    if (payload.too_large) {
      mountPlaceholder("File too large (>512 KB) — diff skipped.");
      return;
    }
    if (payload.is_binary) {
      mountPlaceholder("Binary file — diff not rendered.");
      return;
    }

    diffsEl = document.createElement(DIFFS_TAG_NAME);
    diffsEl.style.display = "block";
    contentRef.appendChild(diffsEl);

    fd = new FileDiff({
      themeType: "dark",
      diffStyle: style,
      disableFileHeader: true,
    });

    const name = basename(props.status.path);
    const oldFile =
      payload.old_contents !== null
        ? { name, contents: payload.old_contents }
        : undefined;
    const newFile =
      payload.new_contents !== null
        ? { name, contents: payload.new_contents }
        : undefined;

    requestAnimationFrame(() => {
      try {
        fd!.render({ oldFile, newFile, fileContainer: diffsEl });
        rendered = true;
        lastStyle = style;
      } catch (err) {
        console.warn("FileDiff.render threw", err);
        mountPlaceholder("Failed to render diff.");
      }
    });
  }

  // Render on expand; dispose on collapse to free Shiki memory.
  createEffect(
    on(
      () => ({ e: expanded(), s: panel.diffStyle() }),
      ({ e }) => {
        if (e) void ensureRendered();
        else disposeDiff();
      },
    ),
  );

  // Scroll into view when focused from file-tree double-click.
  createEffect(
    on(panel.focused, (f) => {
      if (f === props.status.path && rowRef) {
        rowRef.scrollIntoView({ behavior: "smooth", block: "start" });
        panel.clearFocus();
      }
    }),
  );

  onCleanup(disposeDiff);

  return (
    <div ref={rowRef} class="border-b border-neutral-800/80">
      <button
        onClick={() => panel.toggleFile(props.status.path)}
        class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900/60 transition"
      >
        {expanded() ? (
          <ChevronDown size={12} strokeWidth={2} class="shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight size={12} strokeWidth={2} class="shrink-0 text-neutral-500" />
        )}
        <span
          class={
            "text-[10px] font-mono font-bold w-3 text-center shrink-0 " +
            BADGE_COLOR[props.status.kind]
          }
          title={props.status.kind}
        >
          {BADGE_LETTER[props.status.kind]}
        </span>
        <span class="text-[12px] text-neutral-200 truncate">
          {basename(props.status.path)}
        </span>
        <Show when={dirname(props.status.path)}>
          <span class="text-[11px] text-neutral-500 truncate">
            {dirname(props.status.path)}
          </span>
        </Show>
        <span class="ml-auto text-[10px] font-mono flex items-center gap-1.5 shrink-0">
          <span class="text-emerald-400">+{props.status.adds}</span>
          <span class="text-rose-400">−{props.status.dels}</span>
        </span>
      </button>
      <Show when={expanded()}>
        <div
          ref={contentRef}
          class="bg-neutral-950 border-t border-neutral-800/60"
        />
      </Show>
    </div>
  );
}
