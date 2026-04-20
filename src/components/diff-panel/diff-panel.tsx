import { ChevronsDownUp, ChevronsUpDown, FileText, GitBranch, X } from "lucide-solid";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { useDiffPanel, tabKey, type PanelTab } from "@/context/diff-panel";
import { useGit } from "@/context/git";
import { DiffFileRow } from "./diff-file-row";
import { FilePreview } from "./file-preview";

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
      <div class="flex-1 min-h-0 overflow-hidden">
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
  const tabs = () => panel.tabsFor(props.projectPath);
  const activeKey = () => panel.activeKeyFor(props.projectPath);

  return (
    <div class="h-9 shrink-0 flex items-stretch border-b border-neutral-800 bg-neutral-950 overflow-x-auto no-scrollbar">
      <For each={tabs()}>
        {(t) => {
          const key = tabKey(t);
          const isActive = () => activeKey() === key;
          return (
            <TabItem
              tab={t}
              active={isActive()}
              onActivate={() => panel.setActiveTab(props.projectPath, key)}
              onClose={() => panel.closeTab(props.projectPath, key)}
            />
          );
        }}
      </For>
      <div class="flex-1" />
      <button
        class="w-9 shrink-0 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition flex items-center justify-center"
        title="Close diff panel (⌘⇧D)"
        onClick={() => panel.close()}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

function TabItem(props: {
  tab: PanelTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const label = () => {
    if (props.tab.kind === "diff") return "Git changes";
    return basename(props.tab.path);
  };

  return (
    <div
      class={
        "group h-full min-w-0 flex items-center gap-1.5 px-3 text-[12px] cursor-default border-r border-neutral-800 transition " +
        (props.active
          ? "bg-neutral-900 text-neutral-100"
          : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200")
      }
      onClick={props.onActivate}
    >
      <Show
        when={props.tab.kind === "diff"}
        fallback={<FileText size={12} strokeWidth={1.75} class="shrink-0 text-neutral-500" />}
      >
        <GitBranch size={12} strokeWidth={1.75} class="shrink-0 text-neutral-500" />
      </Show>
      <span class="truncate max-w-[180px]">{label()}</span>
      <Show when={props.tab.kind === "file"}>
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
