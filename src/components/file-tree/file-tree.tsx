import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Copy, Eye, FolderOpen } from "lucide-solid";
import { ContextMenu, type ContextMenuItem } from "@/components/context-menu";
import { useGit } from "@/context/git";
import { useDiffPanel } from "@/context/diff-panel";
import { useOpenIn } from "@/context/open-in";
import { useEditorPty } from "@/context/editor-pty";
import { TreeNode } from "./tree-node";
import { makeFileTreeStore, type FsEvent } from "./use-file-tree";

type Props = {
  projectPath: string;
};

type Store = ReturnType<typeof makeFileTreeStore>;

/** Cache the store per project so switching tabs doesn't reload + lose
 *  expanded state. Also survives project switches. */
const storeCache = new Map<string, Store>();

function getStore(projectPath: string): Store {
  let s = storeCache.get(projectPath);
  if (!s) {
    s = makeFileTreeStore(projectPath);
    storeCache.set(projectPath, s);
  }
  return s;
}

export function FileTree(props: Props) {
  const [selected, setSelected] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<
    | { open: false }
    | { open: true; x: number; y: number; path: string; isDir: boolean }
  >({ open: false });
  const [error, setError] = createSignal<string | null>(null);

  const git = useGit();
  const diffPanel = useDiffPanel();
  const openIn = useOpenIn();
  const editorPty = useEditorPty();

  // Memoized store follows the prop — switching projects swaps the store.
  const store = createMemo(() => getStore(props.projectPath));

  // Git status keyed by absolute path. Reruns whenever the git store patches
  // (re-fetched on fs events).
  const statusMap = createMemo(() => git.statusByAbsPath(props.projectPath));

  function toRel(abs: string): string {
    const base = props.projectPath.endsWith("/")
      ? props.projectPath.slice(0, -1)
      : props.projectPath;
    if (abs.startsWith(base + "/")) return abs.slice(base.length + 1);
    return abs;
  }

  function handleOpen(abs: string) {
    const rel = toRel(abs);
    const map = statusMap();
    if (map.has(abs)) {
      diffPanel.focusFile(props.projectPath, rel);
    } else {
      diffPanel.openFile(props.projectPath, rel);
    }
  }

  /** Open a file in the user's default terminal editor (or the first
   *  detected one if no default is set). Dedupes against existing editor
   *  tabs, and remembers the selection so the next Cmd+click / submenu
   *  default-check stays consistent. */
  function openInDefaultEditor(abs: string, editorId: string, appId: string) {
    const rel = toRel(abs);
    openIn.setDefaultEditor(appId);
    const existing = diffPanel.findEditorTabKey(
      props.projectPath,
      editorId,
      rel,
    );
    if (existing) {
      diffPanel.setActiveTab(props.projectPath, existing);
      diffPanel.openPanel();
      return;
    }
    try {
      const ptyId = editorPty.openEditor(
        props.projectPath,
        abs,
        rel,
        editorId,
      );
      diffPanel.addEditorTab(props.projectPath, editorId, rel, ptyId);
    } catch (err) {
      console.warn("openEditor failed", err);
    }
  }

  /** Cmd/Ctrl+click on a file opens it in the default terminal editor when
   *  one is available; otherwise falls through to the preview tab. */
  function handleClickWithMods(e: MouseEvent, abs: string, isDir: boolean) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || isDir) return false;
    const defaultApp = openIn.resolveDefaultEditor();
    if (!defaultApp?.terminalEditor) return false;
    e.preventDefault();
    openInDefaultEditor(abs, defaultApp.terminalEditor, defaultApp.id);
    return true;
  }

  // Per-project listener + watcher. Rebinds when projectPath changes so that
  // the user sees project B's tree (and events) immediately after switching
  // from A. Without this, <SidebarPanel> stays mounted and FileTree would
  // remain wired to the initial project.
  let unlisten: UnlistenFn | null = null;
  createEffect(
    on(
      () => props.projectPath,
      (path) => {
        // Snapshot the store for THIS path. The listener closure writes to
        // this store specifically — not to whatever store() returns at
        // event-dispatch time (which could be a different project).
        const pathStore = getStore(path);

        // Cleanup previous listener.
        const prev = unlisten;
        unlisten = null;
        if (prev) prev();

        // Async setup — load root + attach listener + ask Rust to watch.
        void (async () => {
          try {
            await pathStore.ensureLoaded();
          } catch (err) {
            setError(String(err));
          }
          try {
            unlisten = await listen<FsEvent>(`fs:event:${path}`, (e) =>
              pathStore.applyFsEvent(e.payload),
            );
            await invoke("watch_project", { projectPath: path });
          } catch (err) {
            console.warn("watch_project failed", err);
          }
        })();
      },
    ),
  );

  onCleanup(() => {
    if (unlisten) unlisten();
  });

  function openContextMenu(e: MouseEvent, path: string, isDir: boolean) {
    setSelected(path);
    setMenu({ open: true, x: e.clientX, y: e.clientY, path, isDir });
  }

  function closeMenu() {
    setMenu({ open: false });
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
    } catch (err) {
      console.warn("clipboard.writeText failed", err);
    }
  }

  async function reveal(path: string) {
    try {
      await revealItemInDir(path);
    } catch (err) {
      console.warn("revealItemInDir failed", err);
    }
  }

  const menuItems = (): ContextMenuItem[] => {
    const m = menu();
    if (!m.open) return [];
    const items: ContextMenuItem[] = [];

    if (!m.isDir) {
      items.push({
        label: "Open in preview",
        icon: Eye,
        onClick: () => diffPanel.openFile(props.projectPath, toRel(m.path)),
      });
    }

    // Terminal editors only make sense for files (nvim-on-directory is
    // valid-ish, but out of scope for v1). Show them only when !isDir.
    const apps = m.isDir
      ? openIn.availableApps().filter((a) => !a.terminalEditor)
      : openIn.availableApps();
    const defaultEditor = openIn.defaultEditorId();
    const openInItems: ContextMenuItem[] = apps.map((app) => ({
      label: app.label,
      icon: app.icon,
      iconUrl: openIn.iconUrlFor(app.id) ?? undefined,
      iconClass: app.color,
      checked: !!app.terminalEditor && app.id === defaultEditor,
      onClick: () => {
        if (app.terminalEditor) {
          openInDefaultEditor(m.path, app.terminalEditor, app.id);
        } else {
          void openIn.openPath(m.path, app.id);
        }
      },
    }));
    items.push({
      kind: "submenu",
      label: "Open in",
      icon: FolderOpen,
      items: openInItems,
    });

    items.push({ kind: "divider" });
    items.push({
      label: "Copy path",
      icon: Copy,
      onClick: () => void copyPath(m.path),
    });
    items.push({
      label: "Reveal in Finder",
      icon: FolderOpen,
      onClick: () => void reveal(m.path),
    });
    return items;
  };

  return (
    <div class="h-full flex flex-col">
      <Show when={error()}>
        <div class="px-3 py-2 text-[11px] text-red-400">
          Error: {error()}
        </div>
      </Show>
      <div class="flex-1 overflow-y-auto py-1">
        <For each={store().flatten()}>
          {(row) => (
            <TreeNode
              node={row.node}
              depth={row.depth}
              selected={selected() === row.node.path}
              status={statusMap().get(row.node.path)}
              onToggle={(path) => void store().toggleDir(path)}
              onSelect={(path) => setSelected(path)}
              onOpen={handleOpen}
              onContextMenu={openContextMenu}
              onModClick={handleClickWithMods}
            />
          )}
        </For>
        <Show when={store().root.loaded && store().root.children.length === 0}>
          <div class="px-3 py-4 text-[11px] text-neutral-500">
            Empty (or fully gitignored).
          </div>
        </Show>
      </div>
      {(() => {
        const m = menu();
        return (
          <ContextMenu
            open={m.open}
            x={m.open ? m.x : 0}
            y={m.open ? m.y : 0}
            items={menuItems()}
            onClose={closeMenu}
          />
        );
      })()}
    </div>
  );
}
