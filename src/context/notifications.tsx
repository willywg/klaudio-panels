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
import { playTaskComplete } from "@/lib/sound";

type SessionCompletePayload = {
  project_path: string;
  session_id: string;
  stop_reason: string;
  preview: string | null;
};

/// Two callbacks the App provides so the notification context can decide
/// what to suppress:
///
/// - `isActiveProject(path)`: true when `path` is the project the user is
///   currently looking at in Klaudio. Combined with `focused()` it means
///   "the user is literally here right now" — used to suppress the visual
///   marker (markUnread) so we don't paint an amber ring on the project
///   they're already staring at.
///
/// - `hasTabInProject(path)`: true when at least one Claude tab exists
///   for that project. Used (combined with `focused()`) to suppress the
///   OS notification: if you've explicitly opened a tab in this project
///   you're tracking it, no need to be pestered with a banner. Sound
///   still plays as a gentle audio cue, and the avatar still gets the
///   amber ring so a quick glance at the sidebar tells you what
///   happened.
type ProjectResolver = {
  isActiveProject: (projectPath: string) => boolean;
  hasTabInProject: (projectPath: string) => boolean;
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

  // Default no-op resolver until App.tsx wires the real one. Keeping
  // both callbacks separate (vs. a single boolean resolver) lets
  // handleComplete apply different suppression to the visual indicator
  // and the OS notification — see ProjectResolver doc.
  let resolver: ProjectResolver = {
    isActiveProject: () => false,
    hasTabInProject: () => false,
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
  // when Klaudio is buried behind other windows. Cleared (badge hidden)
  // when the count drops to zero.
  createEffect(() => {
    const count = unread().size;
    void invoke("set_dock_badge", { count }).catch(() => {
      // Non-macOS or API unavailable — silent fallback, the in-app
      // amber ring already covers the indicator on the same machine.
    });
  });

  let unlistenComplete: UnlistenFn | null = null;
  let unlistenFocus: UnlistenFn | null = null;

  onMount(async () => {
    // Notifications are routed through `osascript display notification`
    // via the Rust `notify_native` command — no permission flow on our
    // side. macOS handles permission for AppleScript Notifications
    // globally (and historically grants it).
    const win = getCurrentWindow();
    try {
      setFocused(await win.isFocused());
    } catch {
      setFocused(true);
    }
    // onFocusChanged is the documented v2 API. Raw `tauri://focus` /
    // `tauri://blur` events are not guaranteed across platforms.
    unlistenFocus = await win.onFocusChanged(({ payload }) => {
      setFocused(payload);
    });

    unlistenComplete = await listen<SessionCompletePayload>(
      "session:complete",
      (e) => handleComplete(e.payload),
    );
  });

  onCleanup(() => {
    unlistenComplete?.();
    unlistenFocus?.();
  });

  function handleComplete(payload: SessionCompletePayload) {
    // Three signals, three independent suppression rules. Sound always
    // fires (gentle audio cue). Visual marker fires unless the user is
    // literally on this project right now. OS notification fires unless
    // the user has any tab open for it (broader awareness — they're
    // tracking it from somewhere).
    const here =
      focused() && resolver.isActiveProject(payload.project_path);
    const hasTab = resolver.hasTabInProject(payload.project_path);

    playTaskComplete();

    if (!here) {
      markUnread(payload.project_path);
    }

    if (!(focused() && hasTab)) {
      const title = `${projectName(payload.project_path)} · Claude is done`;
      const body =
        payload.preview && payload.preview.length > 0
          ? payload.preview
          : "Your turn — open Klaudio Panels.";
      void invoke("notify_native", { title, body }).catch(() => {
        // osascript missing or sandbox-blocked — amber ring already
        // covers the visual signal, no need to surface this.
      });
    }
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
