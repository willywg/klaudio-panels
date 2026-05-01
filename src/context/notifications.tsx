import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type ParentProps,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { playPermissionRequest, playTaskComplete } from "@/lib/sound";

type SessionCompletePayload = {
  project_path: string;
  session_id: string;
  stop_reason: string;
  preview: string | null;
};

/// Shape emitted by the OSC 777 sniffer in `src-tauri/src/cli_agent.rs`.
/// Mirrors warp's CLI-agent protocol v1 schema. We only branch on the
/// fields we currently consume (`event`, `cwd`, `tool_name`,
/// `tool_input_preview`, `query`); the rest are kept for forward
/// compatibility / debugging.
type CliAgentEvent = {
  v: number;
  agent: string;
  event: string;
  session_id: string | null;
  cwd: string | null;
  project: string | null;
  query: string | null;
  response: string | null;
  transcript_path: string | null;
  summary: string | null;
  tool_name: string | null;
  tool_input_preview: string | null;
  plugin_version: string | null;
};

export type ToastKind = "complete" | "permission";

export type Toast = {
  id: number;
  kind: ToastKind;
  projectPath: string;
  title: string;
  body: string;
};

/// Backing items for the notification bell — every alert is recorded
/// here regardless of focus state, so the bell becomes the catch-all
/// for "things you missed." Cleared per-project on activation.
export type UnreadItem = {
  id: number;
  kind: ToastKind;
  projectPath: string;
  title: string;
  body: string;
  createdAt: number;
};

/// Three callbacks the App provides so the notification context can
/// decide what to suppress and where to route an alert:
///
/// - `isActiveProject(path)`: true when `path` is the project the user
///   is currently looking at in Klaudio. Combined with `focused()` it
///   means "the user is literally here right now" — used to suppress
///   the visual marker (markUnread) so we don't paint an amber ring
///   on the project they're already staring at.
///
/// - `resolveOpenProject(cwd)`: maps an arbitrary cwd reported by the
///   plugin to one of the open project paths in our store. Claude can
///   be invoked from a subdir of the project root, so the match is
///   prefix-based.
///
/// - `activateProject(path)`: switches the active project, used by the
///   toast click handler. The host's project-switch effect already
///   runs `markRead(path)` so the amber ring clears as a side effect.
type ProjectResolver = {
  isActiveProject: (projectPath: string) => boolean;
  resolveOpenProject: (cwd: string | null) => string | null;
  activateProject: (projectPath: string) => void;
};

const MAX_VISIBLE_TOASTS = 5;
const MAX_UNREAD_ITEMS = 50;
const AUTODISMISS_NEUTRAL_MS = 5000;
const AUTODISMISS_PERMISSION_MS = 10000;

function projectName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function autoDismissMs(kind: ToastKind): number {
  return kind === "permission" ? AUTODISMISS_PERMISSION_MS : AUTODISMISS_NEUTRAL_MS;
}

function makeNotificationsContext() {
  // `unread` carries the steady amber ring on each project's avatar.
  // Cleared only when the user activates the project (markRead).
  const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set());

  // Tracked synchronously so handleComplete can decide suppression
  // without an async round-trip. Defaults to true; if onMount races a
  // completion we'd rather over-notify briefly than silently swallow.
  const [focused, setFocused] = createSignal<boolean>(true);

  const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
  const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextToastId = 1;

  // Bell-backed list of items the user hasn't acknowledged yet.
  // Capped at MAX_UNREAD_ITEMS in memory; not persisted to localStorage
  // (a Klaudio restart starts the bell empty by design).
  const [unreadItems, setUnreadItems] = createSignal<readonly UnreadItem[]>([]);
  let nextItemId = 1;

  // Default no-op resolver until App.tsx wires the real one.
  let resolver: ProjectResolver = {
    isActiveProject: () => false,
    resolveOpenProject: () => null,
    activateProject: () => {},
  };

  function setProjectResolver(next: ProjectResolver) {
    resolver = next;
  }

  function markUnread(projectPath: string) {
    setUnread((prev) => {
      if (prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.add(projectPath);
      return next;
    });
  }

  function markRead(projectPath: string) {
    setUnread((prev) => {
      if (!prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.delete(projectPath);
      return next;
    });
    clearProjectItems(projectPath);
  }

  function enqueueUnreadItem(seed: Omit<UnreadItem, "id" | "createdAt">) {
    const item: UnreadItem = {
      ...seed,
      id: nextItemId++,
      createdAt: Date.now(),
    };
    setUnreadItems((prev) => {
      const next = [item, ...prev];
      return next.length > MAX_UNREAD_ITEMS
        ? next.slice(0, MAX_UNREAD_ITEMS)
        : next;
    });
  }

  function clearProjectItems(projectPath: string) {
    setUnreadItems((prev) =>
      prev.some((x) => x.projectPath === projectPath)
        ? prev.filter((x) => x.projectPath !== projectPath)
        : prev,
    );
  }

  function clearAllItems() {
    setUnreadItems([]);
  }

  function isUnread(projectPath: string): boolean {
    return unread().has(projectPath);
  }

  function dismissToast(id: number) {
    const t = dismissTimers.get(id);
    if (t) {
      clearTimeout(t);
      dismissTimers.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }

  function enqueueToast(t: Omit<Toast, "id">) {
    const id = nextToastId++;
    const toast: Toast = { ...t, id };
    setToasts((prev) => {
      // Newest first, cap at MAX_VISIBLE — drop the oldest (last) if
      // we'd exceed the cap. Do it inside the setter so we can also
      // tear down the dropped toast's auto-dismiss timer.
      const next = [toast, ...prev];
      while (next.length > MAX_VISIBLE_TOASTS) {
        const dropped = next.pop();
        if (dropped) {
          const handle = dismissTimers.get(dropped.id);
          if (handle) {
            clearTimeout(handle);
            dismissTimers.delete(dropped.id);
          }
        }
      }
      return next;
    });
    const timer = setTimeout(() => dismissToast(id), autoDismissMs(t.kind));
    dismissTimers.set(id, timer);
  }

  function activateAndDismiss(toast: Toast) {
    // Activating routes through the App's project-switch effect, which
    // calls markRead → clearProjectItems. We still clear here defensively
    // in case the resolver is ever wired to a no-op (early-mount).
    resolver.activateProject(toast.projectPath);
    clearProjectItems(toast.projectPath);
    dismissToast(toast.id);
  }

  function activateProjectFromBell(projectPath: string) {
    resolver.activateProject(projectPath);
    clearProjectItems(projectPath);
  }

  /// Toast lifecycle helpers used by the toast component to pause the
  /// auto-dismiss while the cursor is over the card. On mouse-leave we
  /// schedule a fresh full-duration timer rather than tracking remaining
  /// time — matches Slack/Discord behavior and keeps the implementation
  /// simple ("pause means the user wants to read; restart cleanly when
  /// they're done").
  function pauseToastDismiss(id: number) {
    const t = dismissTimers.get(id);
    if (t) {
      clearTimeout(t);
      dismissTimers.delete(id);
    }
  }

  function resumeToastDismiss(id: number) {
    if (dismissTimers.has(id)) return;
    const toast = toasts().find((x) => x.id === id);
    if (!toast) return;
    const handle = setTimeout(() => dismissToast(id), autoDismissMs(toast.kind));
    dismissTimers.set(id, handle);
  }

  // Push the count of unread projects into the macOS Dock badge so the
  // user gets at-a-glance "you have N projects waiting" awareness even
  // when Klaudio is buried behind other windows.
  createEffect(() => {
    const count = unread().size;
    void invoke("set_dock_badge", { count }).catch(() => {});
  });

  let unlistenComplete: UnlistenFn | null = null;
  let unlistenAgent: UnlistenFn | null = null;
  let unlistenFocus: UnlistenFn | null = null;

  onMount(async () => {
    const win = getCurrentWindow();
    try {
      setFocused(await win.isFocused());
    } catch {
      setFocused(true);
    }
    unlistenFocus = await win.onFocusChanged(({ payload }) => {
      setFocused(payload);
    });

    unlistenComplete = await listen<SessionCompletePayload>(
      "session:complete",
      (e) => handleComplete(e.payload),
    );
    unlistenAgent = await listen<CliAgentEvent>("claude:event", (e) =>
      handleAgentEvent(e.payload),
    );
  });

  onCleanup(() => {
    unlistenComplete?.();
    unlistenAgent?.();
    unlistenFocus?.();
    for (const t of dismissTimers.values()) clearTimeout(t);
    dismissTimers.clear();
  });

  /// Common alert path: paint the amber ring (unless user is here),
  /// record the event in the bell list (always — it's the catch-all
  /// for "what happened while I was elsewhere"), then route the
  /// active surface based on focus state — in-app toast when focused,
  /// OS native banner when blurred. Sound is the caller's
  /// responsibility since each event uses a different chime.
  function alertProject(
    projectPath: string,
    title: string,
    body: string,
    kind: ToastKind,
  ) {
    const here = focused() && resolver.isActiveProject(projectPath);

    if (!here) {
      markUnread(projectPath);
      enqueueUnreadItem({ kind, projectPath, title, body });
    }

    if (focused()) {
      enqueueToast({ kind, projectPath, title, body });
    } else {
      void invoke("notify_native", { title, body }).catch(() => {});
    }
  }

  function handleComplete(payload: SessionCompletePayload) {
    playTaskComplete();
    const title = `${projectName(payload.project_path)} · Claude is done`;
    const body =
      payload.preview && payload.preview.length > 0
        ? payload.preview
        : "Your turn — open Klaudio Panels.";
    alertProject(payload.project_path, title, body, "complete");
  }

  function handleAgentEvent(payload: CliAgentEvent) {
    // Only `permission_request` reaches the frontend — `stop` and
    // `idle_prompt` are dropped server-side in cli_agent.rs.
    if (payload.event !== "permission_request") return;
    const projectPath = resolver.resolveOpenProject(payload.cwd);
    if (!projectPath) return;

    playPermissionRequest();
    const tool = payload.tool_name ?? "a tool";
    const preview = payload.tool_input_preview;
    const body = preview && preview.length > 0 ? `${tool}: ${preview}` : tool;
    const title = `${projectName(projectPath)} · Claude needs permission`;
    alertProject(projectPath, title, body, "permission");
  }

  return {
    isUnread,
    markRead,
    markUnread,
    setProjectResolver,
    toasts,
    dismissToast,
    activateAndDismiss,
    pauseToastDismiss,
    resumeToastDismiss,
    unreadItems,
    activateProjectFromBell,
    clearAllItems,
  };
}

const Ctx = createContext<ReturnType<typeof makeNotificationsContext>>();

export function NotificationsProvider(props: ParentProps) {
  const ctx = makeNotificationsContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useNotifications() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotifications outside NotificationsProvider");
  return v;
}
