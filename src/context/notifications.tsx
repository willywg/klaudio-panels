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

/// Three callbacks the App provides so the notification context can
/// decide what to suppress and where to attach the alert:
///
/// - `isActiveProject(path)`: true when `path` is the project the user
///   is currently looking at in Klaudio. Combined with `focused()` it
///   means "the user is literally here right now" — used to suppress
///   the visual marker (markUnread) so we don't paint an amber ring
///   on the project they're already staring at.
///
/// - `hasTabInProject(path)`: true when at least one Claude tab exists
///   for that project. Used (combined with `focused()`) to suppress
///   the OS notification: if you've explicitly opened a tab in this
///   project you're tracking it, no need to be pestered with a banner.
///
/// - `resolveOpenProject(cwd)`: maps an arbitrary cwd reported by the
///   plugin to one of the open project paths in our store. Claude can
///   be invoked from a subdir of the project root, so the match is
///   prefix-based. Returns null if no open project contains the cwd —
///   the OSC event is then silently dropped (likely from a Claude
///   instance not spawned by Klaudio, which shouldn't happen in
///   practice but defends us against future flows).
type ProjectResolver = {
  isActiveProject: (projectPath: string) => boolean;
  hasTabInProject: (projectPath: string) => boolean;
  resolveOpenProject: (cwd: string | null) => string | null;
};

function projectName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function makeNotificationsContext() {
  // `unread` carries the steady amber ring on each project's avatar.
  // Cleared only when the user activates the project (markRead). No
  // pulse animation, no time-bounded transition — feedback was that the
  // 4.5s pulse-then-settle UX was easy to miss on background projects.
  // A persistent amber ring is the simplest "still pending" affordance.
  const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set());

  // Tracked synchronously so handleComplete can decide suppression
  // without an async round-trip. Defaults to true; if onMount races a
  // completion we'd rather over-notify briefly than silently swallow.
  const [focused, setFocused] = createSignal<boolean>(true);

  // Default no-op resolver until App.tsx wires the real one.
  let resolver: ProjectResolver = {
    isActiveProject: () => false,
    hasTabInProject: () => false,
    resolveOpenProject: () => null,
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
  }

  function isUnread(projectPath: string): boolean {
    return unread().has(projectPath);
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
  });

  /// Common alert path: paint the amber ring (unless user is here),
  /// fire the OS notification (unless user has any tab for the project
  /// AND the window is focused). Sound is the caller's responsibility
  /// since each event type uses a different chime.
  function alertProject(projectPath: string, title: string, body: string) {
    const here = focused() && resolver.isActiveProject(projectPath);
    const hasTab = resolver.hasTabInProject(projectPath);

    if (!here) {
      markUnread(projectPath);
    }
    if (!(focused() && hasTab)) {
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
    alertProject(payload.project_path, title, body);
  }

  function handleAgentEvent(payload: CliAgentEvent) {
    // Only events warp's plugin emits that JSONL doesn't already cover.
    // `stop` is dropped server-side (cli_agent.rs); ignore everything
    // else we don't have a handler for.
    if (
      payload.event !== "permission_request" &&
      payload.event !== "idle_prompt"
    ) {
      return;
    }
    const projectPath = resolver.resolveOpenProject(payload.cwd);
    if (!projectPath) return;

    if (payload.event === "permission_request") {
      playPermissionRequest();
      const tool = payload.tool_name ?? "a tool";
      const preview = payload.tool_input_preview;
      const body = preview && preview.length > 0 ? `${tool}: ${preview}` : tool;
      const title = `${projectName(projectPath)} · Claude needs permission`;
      alertProject(projectPath, title, body);
      return;
    }

    // idle_prompt
    playTaskComplete();
    const title = `${projectName(projectPath)} · Claude is waiting for you`;
    const body =
      payload.query && payload.query.length > 0
        ? payload.query
        : "Open Klaudio Panels.";
    alertProject(projectPath, title, body);
  }

  return {
    isUnread,
    markRead,
    markUnread,
    setProjectResolver,
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
