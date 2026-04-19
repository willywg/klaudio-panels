import { ChevronRight, Folder, FolderOpen } from "lucide-solid";
import { iconForFile } from "@/lib/file-icon";
import type { TreeNode as TreeNodeType } from "./use-file-tree";

type Props = {
  node: TreeNodeType;
  depth: number;
  selected: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, isDir: boolean) => void;
};

export function TreeNode(props: Props) {
  const FileIcon = () => iconForFile(props.node.name);

  function onClick(e: MouseEvent) {
    e.preventDefault();
    props.onSelect(props.node.path);
    if (props.node.isDir) {
      props.onToggle(props.node.path);
    }
  }

  return (
    <button
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu(e, props.node.path, props.node.isDir);
      }}
      class={
        "w-full flex items-center gap-1 px-2 py-0.5 text-[12px] text-left transition border-l-2 " +
        (props.selected
          ? "bg-neutral-800/60 border-indigo-500 text-neutral-100"
          : "border-transparent text-neutral-300 hover:bg-neutral-900/60")
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
            const Icon = FileIcon();
            return <Icon size={13} strokeWidth={2} class="shrink-0 text-neutral-500" />;
          })()}
        </>
      )}
      <span class="truncate">{props.node.name}</span>
    </button>
  );
}
