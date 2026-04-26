import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type JSX,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  ChevronsDownUp,
  Copy,
  Eye,
  EyeOff,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Pencil,
  RotateCw,
  Trash2,
} from "lucide-solid";
import { looksBinaryByExtension } from "@/lib/cm-language";
import { ContextMenu, type ContextMenuItem } from "@/components/context-menu";
import { useGit } from "@/context/git";
import { useDiffPanel } from "@/context/diff-panel";
import { useOpenIn } from "@/context/open-in";
import { useEditorPty } from "@/context/editor-pty";
import { TreeNode } from "./tree-node";
import {
  makeFileTreeStore,
  type FsEvent,
  type FsEventEnvelope,
  type TreeNode as TreeNodeType,
} from "./use-file-tree";

function stripTrailingSlash(p: string): string {
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Read-only walk of the tree store to locate a node by absolute path. */
function findNodeByPath(
  root: TreeNodeType,
  path: string,
): TreeNodeType | null {
  if (root.path === path) return root;
  if (!root.isDir) return null;
  if (!path.startsWith(root.path + "/") && root.path !== "/") return null;
  for (const child of root.children) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }
  return null;
}

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

type CreateMode = "file" | "folder";
type CreateState = {
  mode: CreateMode;
  /** Absolute path of the directory the new entry will be created in. */
  targetDir: string;
};

const SHOW_IGNORED_KEY = "filetree:showIgnored";

function readShowIgnored(): boolean {
  try {
    const v = localStorage.getItem(SHOW_IGNORED_KEY);
    // Default to true — matches user request ("por defecto que se muestren").
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function writeShowIgnored(v: boolean) {
  try {
    localStorage.setItem(SHOW_IGNORED_KEY, v ? "1" : "0");
  } catch {
    // localStorage unavailable — silent skip.
  }
}

export function FileTree(props: Props) {
  const [selected, setSelected] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<
    | { open: false }
    | { open: true; x: number; y: number; path: string; isDir: boolean }
  >({ open: false });
  const [error, setError] = createSignal<string | null>(null);
  const [createState, setCreateState] = createSignal<CreateState | null>(null);
  const [createValue, setCreateValue] = createSignal("");
  const [showIgnored, setShowIgnored] = createSignal(readShowIgnored());
  let createInputEl: HTMLInputElement | undefined;

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
      diffPanel.openPanel(props.projectPath);
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
            unlisten = await listen<FsEventEnvelope>("fs-event", (e) => {
              if (e.payload.project_path !== path) return;
              pathStore.applyFsEvent(e.payload as FsEvent);
            });
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

  /** Compute where a new file/folder should be created, based on the
   *  current selection. If a directory is selected → create inside it.
   *  If a file is selected → create next to it (in its parent dir).
   *  Nothing selected → project root. */
  function resolveCreateTarget(): string {
    const sel = selected();
    if (!sel) return stripTrailingSlash(props.projectPath);
    const node = findNodeByPath(store().root, sel);
    if (!node) return stripTrailingSlash(props.projectPath);
    if (node.isDir) return sel;
    // File selected → create in its parent.
    const idx = sel.lastIndexOf("/");
    return idx > 0 ? sel.slice(0, idx) : stripTrailingSlash(props.projectPath);
  }

  async function startCreate(mode: CreateMode, targetOverride?: string) {
    // Callers (context menu) can pin the target to the right-clicked
    // folder; otherwise we fall back to the current selection.
    const targetDir = targetOverride ?? resolveCreateTarget();
    // Make sure the target directory is expanded so the user sees the
    // inline input (and the created entry, once the watcher emits).
    if (targetDir !== stripTrailingSlash(props.projectPath)) {
      const node = findNodeByPath(store().root, targetDir);
      if (node && node.isDir && !node.expanded) {
        await store().toggleDir(targetDir);
      }
    }
    setCreateState({ mode, targetDir });
    setCreateValue("");
    queueMicrotask(() => createInputEl?.focus());
  }

  function cancelCreate() {
    setCreateState(null);
    setCreateValue("");
  }

  async function submitCreate() {
    const st = createState();
    const name = createValue().trim();
    if (!st || !name) {
      cancelCreate();
      return;
    }
    if (name.includes("/") || name === "." || name === "..") {
      setError(`invalid name: ${name}`);
      return;
    }
    const target = `${st.targetDir}/${name}`;
    try {
      await invoke(st.mode === "file" ? "fs_create_file" : "fs_create_dir", {
        path: target,
      });
      setError(null);
      setSelected(target);
    } catch (err) {
      setError(String(err));
    } finally {
      cancelCreate();
    }
  }

  async function deleteEntry(path: string, isDir: boolean) {
    const name = path.split("/").pop() ?? path;
    const what = isDir ? "folder" : "file";
    const ok = await confirm(
      `Move ${what} "${name}" to the trash?\n\n${path}`,
      { title: "Delete", kind: "warning" },
    );
    if (!ok) return;
    try {
      await invoke("fs_delete", { path, isDir });
      if (selected() === path) setSelected(null);
    } catch (err) {
      setError(String(err));
    }
  }

  function toggleShowIgnored() {
    const next = !showIgnored();
    setShowIgnored(next);
    writeShowIgnored(next);
  }

  function onCreateKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelCreate();
    }
  }

  async function onRefresh() {
    try {
      await store().refresh();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  const menuItems = (): ContextMenuItem[] => {
    const m = menu();
    if (!m.open) return [];
    const items: ContextMenuItem[] = [];

    if (m.isDir) {
      items.push({
        label: "New File",
        icon: FilePlus,
        onClick: () => void startCreate("file", m.path),
      });
      items.push({
        label: "New Folder",
        icon: FolderPlus,
        onClick: () => void startCreate("folder", m.path),
      });
      items.push({ kind: "divider" });
    } else {
      items.push({
        label: "Open in preview",
        icon: Eye,
        onClick: () => diffPanel.openFile(props.projectPath, toRel(m.path)),
      });
      // "Edit" — opens the file in the inline CodeMirror editor. Disabled
      // for obvious binaries (extension probe); the Rust read path is the
      // authoritative gate (it also rejects non-UTF-8 + >1 MiB).
      const binary = looksBinaryByExtension(m.path);
      items.push({
        label: "Edit",
        icon: Pencil,
        disabled: binary,
        onClick: () => {
          diffPanel.openEdit(props.projectPath, toRel(m.path));
          diffPanel.openPanel(props.projectPath);
        },
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
    items.push({ kind: "divider" });
    items.push({
      label: "Delete",
      icon: Trash2,
      iconClass: "text-red-400",
      onClick: () => void deleteEntry(m.path, m.isDir),
    });
    return items;
  };

  /** Compose the list of rows to render — tree nodes + the inline input
   *  for new file/folder, injected at the correct depth inside the target
   *  directory (or at the top when the target is the project root). */
  const renderRows = createMemo(() => {
    const rows = store()
      .flatten(showIgnored())
      .map((r) => ({ kind: "node" as const, row: r }));
    const st = createState();
    if (!st) return rows;

    if (st.targetDir === stripTrailingSlash(props.projectPath)) {
      return [
        { kind: "input" as const, depth: 0 },
        ...rows,
      ];
    }

    const targetIdx = rows.findIndex(
      (r) => r.kind === "node" && r.row.node.path === st.targetDir,
    );
    if (targetIdx < 0) return rows;
    const targetRow = rows[targetIdx];
    if (targetRow.kind !== "node") return rows;
    const depth = targetRow.row.depth + 1;
    return [
      ...rows.slice(0, targetIdx + 1),
      { kind: "input" as const, depth },
      ...rows.slice(targetIdx + 1),
    ];
  });

  return (
    <div class="h-full flex flex-col">
      <div class="h-7 shrink-0 flex items-center justify-between pl-3 pr-1 border-b border-neutral-800/60">
        <span class="text-[10px] uppercase tracking-wider text-neutral-500 truncate">
          Explorer
        </span>
        <div class="flex items-center gap-0.5">
          <HeaderButton
            title="New File"
            onClick={() => void startCreate("file")}
            disabled={createState() !== null}
          >
            <FilePlus size={13} strokeWidth={2} />
          </HeaderButton>
          <HeaderButton
            title="New Folder"
            onClick={() => void startCreate("folder")}
            disabled={createState() !== null}
          >
            <FolderPlus size={13} strokeWidth={2} />
          </HeaderButton>
          <HeaderButton title="Refresh" onClick={() => void onRefresh()}>
            <RotateCw size={13} strokeWidth={2} />
          </HeaderButton>
          <HeaderButton
            title={
              showIgnored() ? "Hide hidden / ignored" : "Show hidden / ignored"
            }
            onClick={toggleShowIgnored}
          >
            {showIgnored() ? (
              <Eye size={13} strokeWidth={2} />
            ) : (
              <EyeOff size={13} strokeWidth={2} />
            )}
          </HeaderButton>
          <HeaderButton
            title="Collapse All"
            onClick={() => store().collapseAll()}
          >
            <ChevronsDownUp size={13} strokeWidth={2} />
          </HeaderButton>
        </div>
      </div>
      <Show when={error()}>
        <div class="px-3 py-2 text-[11px] text-red-400 flex items-start gap-2">
          <span class="flex-1">Error: {error()}</span>
          <button
            class="text-neutral-500 hover:text-neutral-300"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      </Show>
      <div class="flex-1 overflow-y-auto py-1">
        <For each={renderRows()}>
          {(row) => {
            if (row.kind === "input") {
              return (
                <div
                  class="flex items-center gap-1 px-2 py-0.5"
                  style={{ "padding-left": `${8 + row.depth * 12}px` }}
                >
                  <span class="w-[11px] shrink-0" />
                  <span class="w-[13px] h-[13px] shrink-0" />
                  <input
                    ref={createInputEl}
                    value={createValue()}
                    onInput={(e) => setCreateValue(e.currentTarget.value)}
                    onKeyDown={onCreateKey}
                    onBlur={() => {
                      if (createValue().trim()) void submitCreate();
                      else cancelCreate();
                    }}
                    placeholder={
                      createState()?.mode === "file"
                        ? "new file name"
                        : "new folder name"
                    }
                    class="flex-1 min-w-0 bg-neutral-900 border border-indigo-500/60 rounded px-1.5 py-0 text-[12px] text-neutral-100 outline-none focus:border-indigo-400"
                  />
                </div>
              );
            }
            const r = row.row;
            return (
              <TreeNode
                node={r.node}
                depth={r.depth}
                selected={selected() === r.node.path}
                status={statusMap().get(r.node.path)}
                onToggle={(path) => void store().toggleDir(path)}
                onSelect={(path) => setSelected(path)}
                onOpen={handleOpen}
                onContextMenu={openContextMenu}
                onModClick={handleClickWithMods}
                onDelete={(path, isDir) => void deleteEntry(path, isDir)}
              />
            );
          }}
        </For>
        <Show when={store().root.loaded && store().root.children.length === 0}>
          <div class="px-3 py-4 text-[11px] text-neutral-500">
            Empty.
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

function HeaderButton(props: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      class="p-1 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
    >
      {props.children}
    </button>
  );
}
