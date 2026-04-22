import { Show } from "solid-js";
import { ChevronRight, Folder, FolderOpen } from "lucide-solid";
import { iconForFile } from "@/lib/file-icon";
import { BADGE_COLOR, BADGE_LETTER, type FileStatus } from "@/lib/git-status";
import type { TreeNode as TreeNodeType } from "./use-file-tree";

type Props = {
  node: TreeNodeType;
  depth: number;
  selected: boolean;
  status?: FileStatus;
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
};

export function TreeNode(props: Props) {
  const fileIcon = () => iconForFile(props.node.name);

  function onClick(e: MouseEvent) {
    e.preventDefault();
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

  function onDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    // Absolute path in both text/plain (so other apps can read it) and a
    // Klaudio-specific MIME so TerminalView's drop handler can tell our
    // own drags apart from arbitrary browser drags. Path → relative
    // conversion happens at the drop site, since only the target knows
    // which project it belongs to.
    e.dataTransfer.setData("text/plain", props.node.path);
    e.dataTransfer.setData("application/x-klaudio-file", props.node.path);
    e.dataTransfer.effectAllowed = "copy";
  }

  return (
    <button
      draggable={true}
      onDragStart={onDragStart}
      onClick={onClick}
      onDblClick={onDblClick}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu(e, props.node.path, props.node.isDir);
      }}
      class={
        "w-full flex items-center gap-1 px-2 py-0.5 text-[12px] text-left transition border-l-2 " +
        (props.selected
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
