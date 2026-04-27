import { onCleanup, onMount, Show } from "solid-js";
import { ChevronRight, Folder, FolderOpen } from "lucide-solid";
import { iconForFile } from "@/lib/file-icon";
import { BADGE_COLOR, BADGE_LETTER, type FileStatus } from "@/lib/git-status";
import { createInternalDrag } from "@/lib/use-internal-drag";
import type { TreeNode as TreeNodeType } from "./use-file-tree";

type Props = {
  node: TreeNodeType;
  depth: number;
  selected: boolean;
  status?: FileStatus;
  /** True while a reveal-in-tree request is highlighting this row. Painted
   *  as a soft indigo wash that fades out via the existing `transition`
   *  class; FileTree clears it after ~1.2s. */
  highlighted?: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, isDir: boolean) => void;
  /** Intercepts clicks with Cmd/Ctrl held. Returns true if the click was
   *  consumed (skips the default select/toggle flow). */
  onModClick?: (e: MouseEvent, path: string, isDir: boolean) => boolean;
  /** Delete / Backspace with the row focused triggers deletion (with
   *  confirm dialog on the parent's side). */
  onDelete: (path: string, isDir: boolean) => void;
  /** FileTree passes a register/unregister pair so it can scroll a
   *  specific row into view by absolute path (used by reveal-in-tree).
   *  Optional — drag-only callers don't need it. */
  registerRef?: (path: string, el: HTMLElement | null) => void;
};

export function TreeNode(props: Props) {
  const fileIcon = () => iconForFile(props.node.name);

  let buttonRef: HTMLButtonElement | undefined;

  onMount(() => {
    if (buttonRef) props.registerRef?.(props.node.path, buttonRef);
  });
  onCleanup(() => {
    props.registerRef?.(props.node.path, null);
  });

  const drag = createInternalDrag(() => ({
    path: props.node.path,
    label: props.node.name,
  }));

  function onClick(e: MouseEvent) {
    e.preventDefault();
    if (drag.consumedClick()) return;
    if (props.onModClick?.(e, props.node.path, props.node.isDir)) return;
    props.onSelect(props.node.path);
    if (props.node.isDir) {
      props.onToggle(props.node.path);
    }
  }

  function onDblClick(e: MouseEvent) {
    e.preventDefault();
    if (!props.node.isDir) {
      props.onOpen(props.node.path);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      props.onDelete(props.node.path, props.node.isDir);
    }
  }

  return (
    <button
      ref={buttonRef}
      onPointerDown={drag.handlers.onPointerDown}
      onPointerMove={drag.handlers.onPointerMove}
      onPointerUp={drag.handlers.onPointerUp}
      onPointerCancel={drag.handlers.onPointerCancel}
      onClick={onClick}
      onDblClick={onDblClick}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu(e, props.node.path, props.node.isDir);
      }}
      class={
        "w-full flex items-center gap-1 px-2 py-0.5 text-[12px] text-left transition-colors duration-700 border-l-2 " +
        (props.highlighted
          ? "bg-indigo-500/20 border-indigo-400 text-neutral-100"
          : props.selected
            ? "bg-neutral-800/60 border-indigo-500 text-neutral-100"
            : "border-transparent text-neutral-300 hover:bg-neutral-900/60") +
        (props.node.ignored ? " italic opacity-55" : "")
      }
      style={{ "padding-left": `${8 + props.depth * 12}px` }}
      title={props.node.name}
    >
      {props.node.isDir ? (
        <>
          <ChevronRight
            size={11}
            strokeWidth={2.5}
            class={
              "shrink-0 transition-transform " +
              (props.node.expanded ? "rotate-90 text-neutral-300" : "text-neutral-500")
            }
          />
          {props.node.expanded ? (
            <FolderOpen size={13} strokeWidth={2} class="shrink-0 text-indigo-400" />
          ) : (
            <Folder size={13} strokeWidth={2} class="shrink-0 text-neutral-400" />
          )}
        </>
      ) : (
        <>
          <span class="w-[11px] shrink-0" />
          {(() => {
            const { Icon, color } = fileIcon();
            return (
              <Icon
                size={13}
                strokeWidth={2}
                class={"shrink-0 " + color}
              />
            );
          })()}
        </>
      )}
      <span class="truncate">{props.node.name}</span>
      <Show when={props.status}>
        {(s) => (
          <span
            class={
              "ml-auto pl-2 text-[10px] font-mono font-bold shrink-0 " +
              BADGE_COLOR[s().kind]
            }
            title={`${s().kind} (+${s().adds} −${s().dels})`}
          >
            {BADGE_LETTER[s().kind]}
          </span>
        )}
      </Show>
    </button>
  );
}
