import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";

export type TreeNode = {
  path: string;
  name: string;
  isDir: boolean;
  size: number | null;
  expanded: boolean;
  loaded: boolean;
  children: TreeNode[];
};

type FsEntry = {
  path: string;
  name: string;
  is_dir: boolean;
  size: number | null;
};

export type FsEvent =
  | { kind: "created"; path: string; is_dir: boolean }
  | { kind: "modified"; path: string }
  | { kind: "removed"; path: string }
  | { kind: "renamed"; from: string; to: string };

export type FlatRow = { node: TreeNode; depth: number };

function basename(p: string): string {
  const s = p.split("/").filter(Boolean);
  return s[s.length - 1] || p;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}

function compareEntries(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

function insertSorted(list: TreeNode[], node: TreeNode) {
  const idx = list.findIndex((n) => compareEntries(node, n) < 0);
  if (idx < 0) list.push(node);
  else list.splice(idx, 0, node);
}

function findNodeMut(root: TreeNode, path: string): TreeNode | null {
  if (root.path === path) return root;
  if (!root.isDir) return null;
  // Only descend if path is under root.path
  if (!path.startsWith(root.path + "/") && root.path !== "/") return null;
  for (const child of root.children) {
    const found = findNodeMut(child, path);
    if (found) return found;
  }
  return null;
}

export function makeFileTreeStore(projectPath: string) {
  const [root, setRoot] = createStore<TreeNode>({
    path: projectPath,
    name: basename(projectPath) || projectPath,
    isDir: true,
    size: null,
    expanded: true,
    loaded: false,
    children: [],
  });

  function updateNode(path: string, fn: (node: TreeNode) => void) {
    setRoot(
      produce((r: TreeNode) => {
        const node = findNodeMut(r, path);
        if (node) fn(node);
      }),
    );
  }

  async function loadChildren(path: string) {
    const entries = (await invoke("list_dir", { path })) as FsEntry[];
    const children: TreeNode[] = entries.map((e) => ({
      path: e.path,
      name: e.name,
      isDir: e.is_dir,
      size: e.size,
      expanded: false,
      loaded: false,
      children: [],
    }));
    updateNode(path, (n) => {
      n.children = children;
      n.loaded = true;
    });
  }

  async function ensureLoaded() {
    if (!root.loaded) await loadChildren(projectPath);
  }

  async function toggleDir(path: string) {
    const node = findNodeMut(root, path);
    if (!node || !node.isDir) return;
    if (!node.loaded) {
      try {
        await loadChildren(path);
      } catch (err) {
        console.error("list_dir failed for", path, err);
        return;
      }
    }
    updateNode(path, (n) => {
      n.expanded = !n.expanded;
    });
  }

  /** Re-list every currently-loaded directory, preserving expanded state
   *  for paths that still exist. Used by the header "refresh" button. */
  async function refresh() {
    // Collect loaded dir paths before we mutate.
    const loadedDirs: string[] = [];
    const walk = (n: TreeNode) => {
      if (n.isDir && n.loaded) {
        loadedDirs.push(n.path);
        for (const c of n.children) walk(c);
      }
    };
    walk(root);

    for (const p of loadedDirs) {
      try {
        const entries = (await invoke("list_dir", { path: p })) as FsEntry[];
        setRoot(
          produce((r: TreeNode) => {
            const node = findNodeMut(r, p);
            if (!node) return;
            const prevByPath = new Map(node.children.map((c) => [c.path, c]));
            const merged: TreeNode[] = entries.map((e) => {
              const prev = prevByPath.get(e.path);
              if (prev && prev.isDir === e.is_dir) {
                // Preserve expanded/loaded/children so the user's state
                // survives the refresh.
                return {
                  ...prev,
                  name: e.name,
                  size: e.size,
                };
              }
              return {
                path: e.path,
                name: e.name,
                isDir: e.is_dir,
                size: e.size,
                expanded: false,
                loaded: false,
                children: [],
              };
            });
            node.children = merged;
          }),
        );
      } catch (err) {
        // Directory was removed while we were iterating — drop it from
        // the parent's children list.
        console.warn("list_dir failed during refresh", p, err);
      }
    }
  }

  /** Collapse every directory except root. */
  function collapseAll() {
    setRoot(
      produce((r: TreeNode) => {
        const walk = (n: TreeNode) => {
          for (const c of n.children) {
            if (c.isDir) {
              c.expanded = false;
              walk(c);
            }
          }
        };
        walk(r);
      }),
    );
  }

  function applyFsEvent(ev: FsEvent) {
    switch (ev.kind) {
      case "created": {
        const parent = dirname(ev.path);
        const parentNode = findNodeMut(root, parent);
        if (!parentNode || !parentNode.loaded) return;
        if (parentNode.children.some((c) => c.path === ev.path)) return;
        setRoot(
          produce((r: TreeNode) => {
            const pn = findNodeMut(r, parent);
            if (!pn || !pn.loaded) return;
            insertSorted(pn.children, {
              path: ev.path,
              name: basename(ev.path),
              isDir: ev.is_dir,
              size: null,
              expanded: false,
              loaded: false,
              children: [],
            });
          }),
        );
        return;
      }
      case "removed": {
        const parent = dirname(ev.path);
        setRoot(
          produce((r: TreeNode) => {
            const pn = findNodeMut(r, parent);
            if (!pn) return;
            const idx = pn.children.findIndex((c) => c.path === ev.path);
            if (idx >= 0) pn.children.splice(idx, 1);
          }),
        );
        return;
      }
      case "modified": {
        // v1: ignore. If we ever show mtime/size live, patch here.
        return;
      }
      case "renamed": {
        applyFsEvent({ kind: "removed", path: ev.from });
        applyFsEvent({ kind: "created", path: ev.to, is_dir: false });
        return;
      }
    }
  }

  /** Depth-first flatten of all visible (expanded) rows for rendering. */
  function flatten(): FlatRow[] {
    const rows: FlatRow[] = [];
    const walk = (node: TreeNode, depth: number) => {
      if (depth > 0) rows.push({ node, depth: depth - 1 });
      if (node.isDir && node.expanded) {
        for (const child of node.children) walk(child, depth + 1);
      }
    };
    walk(root, 0);
    return rows;
  }

  return {
    root,
    ensureLoaded,
    toggleDir,
    applyFsEvent,
    flatten,
    refresh,
    collapseAll,
  };
}
