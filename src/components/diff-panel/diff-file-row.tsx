import { ChevronDown, ChevronRight } from "lucide-solid";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { DIFFS_TAG_NAME, FileDiff } from "@pierre/diffs";
import { useDiffPanel, type DiffStyle } from "@/context/diff-panel";
import { useGit } from "@/context/git";
import { useOpenIn } from "@/context/open-in";
import {
  BADGE_COLOR,
  BADGE_LETTER,
  type FileStatus,
} from "@/lib/git-status";
import { createFileOpener } from "./use-file-opener";

type Props = {
  projectPath: string;
  status: FileStatus;
  /** Owning repo's project-relative path. Trimmed off the displayed folder
   *  so a submodule group doesn't repeat `backend/` on every row — the group
   *  header already says it. Keys (expand, focus, diff fetch) keep the full
   *  project-relative path. */
  stripPrefix?: string;
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
  const openIn = useOpenIn();
  const opener = createFileOpener(() => props.projectPath);

  /** Why the diff isn't on screen (too large, binary, gone). Rendered as JSX
   *  next to the diff container rather than injected into it, so it can carry
   *  real buttons — a dead-end "diff skipped" line leaves you with no way to
   *  look at the file at all. */
  const [notice, setNotice] = createSignal<string | null>(null);

  const expanded = () => panel.isExpanded(props.status.path);

  /** Path as shown to the user: repo-relative inside a submodule group,
   *  project-relative otherwise. */
  const shownPath = () => {
    const prefix = props.stripPrefix;
    if (!prefix) return props.status.path;
    return props.status.path.startsWith(prefix + "/")
      ? props.status.path.slice(prefix.length + 1)
      : props.status.path;
  };

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

  async function ensureRendered() {
    if (!contentRef) return;
    const style = panel.diffStyle();
    if (rendered && lastStyle === style) return;

    disposeDiff();
    setNotice(null);

    if (props.status.is_binary) {
      setNotice("Binary file — diff not rendered.");
      return;
    }

    const payload = await git.fetchDiff(props.projectPath, props.status.path);
    if (payload.too_large) {
      setNotice("File larger than 512 KB — diff skipped.");
      return;
    }
    if (payload.is_binary) {
      setNotice("Binary file — diff not rendered.");
      return;
    }

    if (payload.old_contents === null && payload.new_contents === null) {
      setNotice("File not found on disk or in HEAD.");
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

    // @pierre/diffs only computes a diff when BOTH sides are non-null — hand
    // it one side and it leaves `fileDiff` undefined and renders an empty
    // container. An added or untracked file has no HEAD side and a deleted
    // one has no workdir side, so both used to expand into a blank panel.
    // Standing in an empty file gives the all-added / all-deleted rendering.
    const name = basename(shownPath());
    const oldFile = { name, contents: payload.old_contents ?? "" };
    const newFile = { name, contents: payload.new_contents ?? "" };

    requestAnimationFrame(() => {
      try {
        fd!.render({ oldFile, newFile, fileContainer: diffsEl });
        rendered = true;
        lastStyle = style;
      } catch (err) {
        console.warn("FileDiff.render threw", err);
        disposeDiff();
        setNotice("Failed to render diff.");
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
          {basename(shownPath())}
        </span>
        <Show when={dirname(shownPath())}>
          <span class="text-[11px] text-neutral-500 truncate">
            {dirname(shownPath())}
          </span>
        </Show>
        <span class="ml-auto text-[10px] font-mono flex items-center gap-1.5 shrink-0">
          <span class="text-emerald-400">+{props.status.adds}</span>
          <span class="text-rose-400">−{props.status.dels}</span>
        </span>
      </button>
      <Show when={expanded()}>
        <div class="bg-neutral-950 border-t border-neutral-800/60">
          <Show when={notice()}>
            {(msg) => (
              <div class="px-4 py-3 flex items-center gap-2 flex-wrap">
                <span class="text-[12px] text-neutral-500">{msg()}</span>
                {/* Every reason we can't draw a diff still leaves a real file
                    on disk, so offer the ways out instead of dead-ending. */}
                <For each={openIn.availableApps()}>
                  {(app) => (
                    <button
                      onClick={() => opener.openWith(app, props.status.path)}
                      class="flex items-center gap-1.5 h-6 px-2 rounded border border-neutral-800 text-[11px] text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
                      title={`Open in ${app.label}`}
                    >
                      <Show
                        when={openIn.iconUrlFor(app.id)}
                        fallback={
                          <app.icon
                            size={11}
                            strokeWidth={2}
                            class={app.color}
                          />
                        }
                      >
                        {(url) => (
                          <img src={url()} alt="" class="w-3 h-3 rounded-sm" />
                        )}
                      </Show>
                      {app.label}
                    </button>
                  )}
                </For>
              </div>
            )}
          </Show>
          <div ref={contentRef} />
        </div>
      </Show>
    </div>
  );
}
