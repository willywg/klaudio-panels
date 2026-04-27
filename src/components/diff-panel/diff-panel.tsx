import {
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileText,
  FolderOpen,
  GitBranch,
  Terminal as TerminalIcon,
  X,
  XCircle,
  Zap,
} from "lucide-solid";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { useDiffPanel, tabKey, type PanelTab } from "@/context/diff-panel";
import { useGit } from "@/context/git";
import { useOpenIn } from "@/context/open-in";
import { useEditorPty } from "@/context/editor-pty";
import { ContextMenu, type ContextMenuItem } from "@/components/context-menu";
import { createInternalDrag } from "@/lib/use-internal-drag";
import { DiffFileRow } from "./diff-file-row";
import { FilePreview } from "./file-preview";
import { EditorPtyView } from "./editor-pty-view";

type Props = {
  projectPath: string;
};

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function DiffPanel(props: Props) {
  const panel = useDiffPanel();
  const git = useGit();

  const statuses = createMemo(() => git.statusFor(props.projectPath));
  const summary = () => git.summaryFor(props.projectPath);
  const tabs = () => panel.tabsFor(props.projectPath);
  const activeKey = () => panel.activeKeyFor(props.projectPath);
  const activeTab = () => tabs().find((t) => tabKey(t) === activeKey());

  const anyExpanded = () =>
    statuses().some((s) => panel.isExpanded(s.path));

  function toggleAll() {
    if (anyExpanded()) {
      panel.collapseAll();
    } else {
      panel.expandAll(statuses().map((s) => s.path));
    }
  }

  return (
    <div class="h-full flex flex-col bg-neutral-950 border-l border-neutral-800">
      <TabStrip projectPath={props.projectPath} />
      <div class="relative flex-1 min-h-0 overflow-hidden">
        {/* Editor PTYs are mounted once per tab and their visibility is
            toggled — tearing them down on tab switch would reset nvim's
            buffers and lose unsaved edits. They sit absolute-positioned on
            top of the Switch and only show when their tab is active. */}
        <For each={tabs().filter((t) => t.kind === "editor")}>
          {(t) => {
            if (t.kind !== "editor") return null;
            const key = tabKey(t);
            const isActive = () => key === activeKey();
            return (
              <div
                class="absolute inset-0 flex flex-col"
                style={{
                  visibility: isActive() ? "visible" : "hidden",
                  "pointer-events": isActive() ? "auto" : "none",
                  "z-index": isActive() ? 2 : 0,
                }}
              >
                <EditorPtyView
                  ptyId={t.ptyId}
                  active={isActive()}
                  onExit={() => panel.closeTab(props.projectPath, key)}
                />
              </div>
            );
          }}
        </For>
        <Switch>
          <Match when={activeTab()?.kind === "diff"}>
            <div class="h-full flex flex-col">
              <div class="h-9 shrink-0 border-b border-neutral-800 flex items-center gap-2 px-3">
                <span class="text-[11px] font-mono text-neutral-500">
                  {statuses().length} file{statuses().length === 1 ? "" : "s"}
                </span>
                <span class="text-[11px] font-mono flex items-center gap-1.5">
                  <span class="text-emerald-400">+{summary().adds}</span>
                  <span class="text-rose-400">−{summary().dels}</span>
                </span>
                <div class="flex-1" />
                <div
                  class="flex items-center rounded border border-neutral-800 overflow-hidden text-[11px]"
                  role="group"
                >
                  <button
                    onClick={() => panel.setDiffStyle("unified")}
                    class={
                      "px-2 h-5 transition " +
                      (panel.diffStyle() === "unified"
                        ? "bg-neutral-800 text-neutral-100"
                        : "text-neutral-400 hover:text-neutral-200")
                    }
                    title="Unified diff"
                  >
                    Unified
                  </button>
                  <button
                    onClick={() => panel.setDiffStyle("split")}
                    class={
                      "px-2 h-5 transition border-l border-neutral-800 " +
                      (panel.diffStyle() === "split"
                        ? "bg-neutral-800 text-neutral-100"
                        : "text-neutral-400 hover:text-neutral-200")
                    }
                    title="Split diff"
                  >
                    Split
                  </button>
                </div>
                <button
                  onClick={toggleAll}
                  class="w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
                  title={anyExpanded() ? "Collapse all" : "Expand all"}
                >
                  <Show
                    when={anyExpanded()}
                    fallback={<ChevronsUpDown size={13} strokeWidth={2} />}
                  >
                    <ChevronsDownUp size={13} strokeWidth={2} />
                  </Show>
                </button>
              </div>
              <div class="flex-1 min-h-0 overflow-y-auto">
                <Show
                  when={statuses().length > 0}
                  fallback={
                    <div class="h-full w-full flex items-center justify-center text-[12px] text-neutral-500">
                      No changes in working directory.
                    </div>
                  }
                >
                  <For each={statuses()}>
                    {(status) => (
                      <DiffFileRow
                        projectPath={props.projectPath}
                        status={status}
                      />
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Match>
          <Match when={activeTab()?.kind === "file"}>
            {(() => {
              const t = activeTab();
              if (!t || t.kind !== "file") return null;
              return (
                <FilePreview
                  projectPath={props.projectPath}
                  relPath={t.path}
                  line={t.line}
                />
              );
            })()}
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function TabStrip(props: { projectPath: string }) {
  const panel = useDiffPanel();
  const openIn = useOpenIn();
  const editorPty = useEditorPty();
  const tabs = () => panel.tabsFor(props.projectPath);
  const activeKey = () => panel.activeKeyFor(props.projectPath);

  const [menu, setMenu] = createSignal<
    | { open: false }
    | {
        open: true;
        x: number;
        y: number;
        key: string;
        rel: string;
        tabKind: "file" | "editor";
        ptyId?: string;
      }
  >({ open: false });

  function openMenu(
    e: MouseEvent,
    key: string,
    rel: string,
    tabKind: "file" | "editor",
    ptyId?: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      open: true,
      x: e.clientX,
      y: e.clientY,
      key,
      rel,
      tabKind,
      ptyId,
    });
  }
  function closeMenu() {
    setMenu({ open: false });
  }

  function copyPath(rel: string) {
    void navigator.clipboard
      .writeText(absFor(rel))
      .catch((err) => console.warn("clipboard write failed", err));
  }

  function absFor(rel: string): string {
    const base = props.projectPath.endsWith("/")
      ? props.projectPath.slice(0, -1)
      : props.projectPath;
    return `${base}/${rel}`;
  }

  function dispatchAppOpen(app: import("@/lib/open-in").OpenInApp, rel: string) {
    if (app.terminalEditor) {
      openIn.setDefaultEditor(app.id);
      const existing = panel.findEditorTabKey(
        props.projectPath,
        app.terminalEditor,
        rel,
      );
      if (existing) {
        panel.setActiveTab(props.projectPath, existing);
        panel.openPanel(props.projectPath);
        return;
      }
      try {
        const editorId = app.terminalEditor;
        const ptyId = editorPty.openEditor(
          props.projectPath,
          absFor(rel),
          rel,
          editorId,
        );
        panel.addEditorTab(props.projectPath, editorId, rel, ptyId);
      } catch (err) {
        console.warn("openEditor failed", err);
      }
    } else {
      void openIn.openPath(absFor(rel), app.id);
    }
  }

  function sendCtrl(ptyId: string, byte: number) {
    void editorPty.write(ptyId, new Uint8Array([byte]));
  }

  const menuItems = (): ContextMenuItem[] => {
    const m = menu();
    if (!m.open) return [];
    const items: ContextMenuItem[] = [];

    items.push({
      label: "Close tab",
      icon: X,
      onClick: () => panel.closeTab(props.projectPath, m.key),
    });
    items.push({
      label: "Close other tabs",
      icon: XCircle,
      onClick: () => {
        for (const t of panel.tabsFor(props.projectPath)) {
          const k = tabKey(t);
          if (k === m.key || k === "diff") continue;
          panel.closeTab(props.projectPath, k);
        }
      },
    });

    // Editor-only: escape hatches for a frozen nvim / a child that's
    // ignoring :q. Ctrl-C sends SIGINT via the PTY; Ctrl-\\ sends SIGQUIT.
    if (m.tabKind === "editor" && m.ptyId) {
      items.push({ kind: "divider" });
      items.push({
        label: "Send Ctrl-C",
        icon: Zap,
        onClick: () => sendCtrl(m.ptyId!, 0x03),
      });
      items.push({
        label: "Send Ctrl-\\",
        icon: Zap,
        onClick: () => sendCtrl(m.ptyId!, 0x1c),
      });
    }

    items.push({ kind: "divider" });

    const defaultEditor = openIn.defaultEditorId();
    const apps: ContextMenuItem[] = openIn.availableApps().map((app) => ({
      label: app.label,
      icon: app.icon,
      iconUrl: openIn.iconUrlFor(app.id) ?? undefined,
      iconClass: app.color,
      checked: !!app.terminalEditor && app.id === defaultEditor,
      onClick: () => dispatchAppOpen(app, m.rel),
    }));
    items.push({
      kind: "submenu",
      label: "Open in",
      icon: FolderOpen,
      items: apps,
    });
    items.push({
      label: "Copy path",
      icon: Copy,
      onClick: () => copyPath(m.rel),
    });
    return items;
  };

  return (
    <>
      <div class="h-9 shrink-0 flex items-stretch border-b border-neutral-800 bg-neutral-950 overflow-x-auto no-scrollbar">
        <For each={tabs()}>
          {(t) => {
            const key = tabKey(t);
            const isActive = () => activeKey() === key;
            return (
              <TabItem
                tab={t}
                projectPath={props.projectPath}
                active={isActive()}
                onActivate={() => panel.setActiveTab(props.projectPath, key)}
                onClose={() => panel.closeTab(props.projectPath, key)}
                onContextMenu={(e) => {
                  if (t.kind === "file") {
                    openMenu(e, key, t.path, "file");
                  } else if (t.kind === "editor") {
                    openMenu(e, key, t.path, "editor", t.ptyId);
                  }
                }}
              />
            );
          }}
        </For>
        <div class="flex-1" />
        <button
          class="w-9 shrink-0 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition flex items-center justify-center"
          title="Close diff panel (⌘⇧D)"
          onClick={() => panel.close(props.projectPath)}
        >
          <X size={14} strokeWidth={2} />
        </button>
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
    </>
  );
}

function TabItem(props: {
  tab: PanelTab;
  /** Project path used to resolve the tab's project-relative `path` to an
   *  absolute path for the drag publisher (and for downstream @rel
   *  conversion in `buildDropPayload`). */
  projectPath: string;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  const label = () => {
    if (props.tab.kind === "diff") return "Git changes";
    if (props.tab.kind === "file") return basename(props.tab.path);
    return `${props.tab.editorId} ${basename(props.tab.path)}`;
  };

  // Drag publisher: file/editor tabs carry a `rel` path; the diff tab does
  // not and returns null so the drag never starts on it. Absolute path is
  // computed inline so we don't bind to a stale projectPath.
  const drag = createInternalDrag(() => {
    if (props.tab.kind === "diff") return null;
    const base = props.projectPath.endsWith("/")
      ? props.projectPath.slice(0, -1)
      : props.projectPath;
    return {
      path: `${base}/${props.tab.path}`,
      label: basename(props.tab.path),
    };
  });

  function onClick(e: MouseEvent) {
    if (drag.consumedClick()) {
      e.preventDefault();
      return;
    }
    props.onActivate();
  }

  return (
    <div
      onPointerDown={drag.handlers.onPointerDown}
      onPointerMove={drag.handlers.onPointerMove}
      onPointerUp={drag.handlers.onPointerUp}
      onPointerCancel={drag.handlers.onPointerCancel}
      class={
        "group h-full min-w-0 flex items-center gap-1.5 px-3 text-[12px] cursor-default border-r border-neutral-800 transition " +
        (props.active
          ? "bg-neutral-900 text-neutral-100"
          : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200")
      }
      onClick={onClick}
      onContextMenu={props.onContextMenu}
    >
      <Switch>
        <Match when={props.tab.kind === "diff"}>
          <GitBranch size={12} strokeWidth={1.75} class="shrink-0 text-neutral-500" />
        </Match>
        <Match when={props.tab.kind === "file"}>
          <FileText size={12} strokeWidth={1.75} class="shrink-0 text-neutral-500" />
        </Match>
        <Match when={props.tab.kind === "editor"}>
          <TerminalIcon size={12} strokeWidth={1.75} class="shrink-0 text-emerald-400" />
        </Match>
      </Switch>
      <span class="truncate max-w-[180px]">{label()}</span>
      <Show when={props.tab.kind !== "diff"}>
        <button
          class="w-4 h-4 rounded-sm flex items-center justify-center text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 transition opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
          title="Close tab (⌘W)"
        >
          <X size={10} strokeWidth={2.5} />
        </button>
      </Show>
    </div>
  );
}
