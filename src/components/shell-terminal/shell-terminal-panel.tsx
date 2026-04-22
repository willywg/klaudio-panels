import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { Plus, X } from "lucide-solid";
import { useShellPty } from "@/context/shell-pty";
import { useShellPanel } from "@/context/shell-panel";
import { ShellTerminalView } from "./shell-terminal-view";

type Props = {
  projectPath: string;
  /** True when this project is the currently-active project AND its shell
   *  panel is open. Non-active panels stay mounted (to keep xterm buffer)
   *  but must tell their ShellTerminalViews they're hidden so the views
   *  don't steal focus or run fit/refresh loops while invisible. */
  isActive: boolean;
};

export function ShellTerminalPanel(props: Props) {
  const pty = useShellPty();
  const panel = useShellPanel();

  const [autoCreated, setAutoCreated] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);

  const tabs = createMemo(() => pty.tabsForProject(props.projectPath));
  const activeId = createMemo(() => pty.activeForProject(props.projectPath));

  // Auto-spawn the first shell when the panel opens for this project and
  // there are no existing tabs. Guarded so closing the last tab (which
  // auto-closes the panel below) doesn't immediately trigger another spawn.
  createEffect(
    on(
      () => [tabs().length, props.projectPath] as const,
      ([count, path]) => {
        if (autoCreated()) return;
        if (count !== 0) return;
        setAutoCreated(true);
        void pty.openTab(path);
      },
    ),
  );

  // Close the panel when the last tab for this project dies (matches
  // OpenCode). `defer: true` so we don't fire on the initial 0-count state.
  createEffect(
    on(
      () => tabs().length,
      (count, prev) => {
        if (prev === undefined) return;
        if (prev > 0 && count === 0) {
          setAutoCreated(false);
          panel.setOpen(props.projectPath, false);
        }
      },
      { defer: true },
    ),
  );

  function handleClosePanel() {
    panel.setOpen(props.projectPath, false);
  }

  function handleNewTab() {
    void pty.openTab(props.projectPath);
  }

  function handleCloseTab(ptyId: string, ev: MouseEvent) {
    ev.stopPropagation();
    void pty.closeTab(ptyId);
  }

  function handleActivate(ptyId: string) {
    pty.setActiveForProject(props.projectPath, ptyId);
  }

  // --- Vertical resize (drag top edge). Pointer-based — same pattern the
  // projects sidebar uses, because WebKit's native HTML5 drag is flaky for
  // continuous-move gestures inside Tauri. ---
  let startY = 0;
  let startHeight = 0;

  function onPointerDown(ev: PointerEvent) {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    startY = ev.clientY;
    startHeight = panel.heightPx();
    setDragging(true);
    ev.preventDefault();
  }

  function onPointerMove(ev: PointerEvent) {
    if (!dragging()) return;
    const delta = startY - ev.clientY;
    panel.setHeightPx(startHeight + delta, false);
  }

  function onPointerUp(ev: PointerEvent) {
    if (!dragging()) return;
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    setDragging(false);
    panel.setHeightPx(panel.heightPx(), true);
  }

  onCleanup(() => {
    // Nothing project-scoped to tear down here. PTYs are owned by
    // ShellPtyProvider; killAllForProject runs from the app-level
    // handleCloseProject when a project is fully closed.
  });

  return (
    <div class="h-full flex flex-col border-t border-neutral-800 bg-neutral-950 overflow-hidden">
      {/* Resize handle — 4px tall hit area, thin visible line inside. */}
      <div
        class="h-1 w-full cursor-ns-resize select-none"
        classList={{
          "bg-indigo-500/40": dragging(),
          "hover:bg-neutral-700/60": !dragging(),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {/* Tab strip — taller, more breathing room; active tab marked only by
          a bottom accent line instead of a heavy bg change. Matches the
          OpenCode aesthetic. */}
      <div class="h-10 shrink-0 flex items-stretch border-b border-neutral-800 bg-neutral-950">
        <div class="flex-1 flex items-stretch overflow-x-auto no-scrollbar">
          <For each={tabs()}>
            {(tab) => {
              const isActive = () => tab.ptyId === activeId();
              return (
                <button
                  class="relative h-full pl-3 pr-2 flex items-center gap-2 text-[13px] whitespace-nowrap transition"
                  classList={{
                    "text-neutral-100": isActive(),
                    "text-neutral-400 hover:text-neutral-200": !isActive(),
                  }}
                  onClick={() => handleActivate(tab.ptyId)}
                >
                  <span>Terminal {tab.index}</span>
                  <span
                    role="button"
                    tabindex={-1}
                    class="w-5 h-5 rounded flex items-center justify-center text-neutral-500 hover:text-neutral-100 hover:bg-neutral-700/60 transition"
                    onClick={(e) => handleCloseTab(tab.ptyId, e)}
                    title="Close terminal"
                  >
                    <X size={12} strokeWidth={2} />
                  </span>
                  <Show when={isActive()}>
                    <span class="absolute inset-x-2 bottom-0 h-[2px] bg-indigo-400 rounded-t" />
                  </Show>
                </button>
              );
            }}
          </For>
          <button
            class="h-full w-9 flex items-center justify-center text-neutral-400 hover:text-neutral-100 transition"
            onClick={handleNewTab}
            title="New terminal"
          >
            <Plus size={15} strokeWidth={1.75} />
          </button>
        </div>
        <button
          class="h-full w-9 flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/60 transition"
          onClick={handleClosePanel}
          title="Hide terminal (⌘J)"
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      {/* View area — mount every tab, toggle visibility so scrollback
          and WebGL state survive switching. Same pattern App.tsx uses for
          the Claude tabs. */}
      <div class="relative flex-1 min-h-0 overflow-hidden">
        <For each={tabs()}>
          {(tab) => {
            // A tab's xterm is truly "active" only when its tab is the
            // selected one AND this whole panel is visible (project active
            // + panel open). Combining both stops hidden panels from
            // triggering fit/refresh/focus on project switch.
            const tabSelected = () => tab.ptyId === activeId();
            const visible = () => tabSelected() && props.isActive;
            return (
              <div
                class="absolute inset-0"
                style={{
                  // MUST use `visible()` (tabSelected && panel active), not
                  // `tabSelected()`. CSS `visibility: visible` on a child
                  // overrides `visibility: hidden` on its ancestor — the one
                  // property in CSS that cascades this way. App.tsx hides
                  // the whole panel of an inactive project via the outer
                  // wrapper; if this inner div forces `visible` on the
                  // selected tab, the inactive project's xterm re-emerges
                  // and, being later in DOM, stacks above the active one →
                  // terminals "cross" between projects when switching.
                  visibility: visible() ? "visible" : "hidden",
                  "pointer-events": visible() ? "auto" : "none",
                  "z-index": visible() ? 1 : 0,
                }}
              >
                <Show when={tab.status !== "opening"} fallback={<ShellLoading />}>
                  <ShellTerminalView ptyId={tab.ptyId} active={visible()} />
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

function ShellLoading() {
  return (
    <div class="absolute inset-0 flex items-center justify-center text-[12px] text-neutral-500">
      <div class="flex items-center gap-2">
        <div class="w-3 h-3 border-2 border-neutral-700 border-t-indigo-400 rounded-full animate-spin" />
        <span>Starting terminal…</span>
      </div>
    </div>
  );
}
