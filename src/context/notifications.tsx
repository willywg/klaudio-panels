import {
  createContext,
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

type IsActiveSessionFn = (
  projectPath: string,
  sessionId: string,
) => boolean;

function projectName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

// Pulse the avatar ring for ~3 cycles (~4.5s @ 1.5s per cycle) when a
// completion lands, then settle into a steady ring until the user
// activates the project. The animation grabs the eye; the steady ring
// keeps the "you have unread work here" affordance without becoming
// visual noise across multiple unread projects.
const PULSE_DURATION_MS = 4500;

function makeNotificationsContext() {
  // Two-tier state: `unread` carries the steady ring (cleared only on
  // markRead); `activelyPulsing` carries the animate-pulse class for
  // ~PULSE_DURATION_MS after the completion fires. Both are cleared
  // when markRead runs.
  const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set());
  const [activelyPulsing, setActivelyPulsing] = createSignal<ReadonlySet<string>>(new Set());
  const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearPulseTimer(projectPath: string) {
    const t = pulseTimers.get(projectPath);
    if (t !== undefined) {
      clearTimeout(t);
      pulseTimers.delete(projectPath);
    }
  }

  function startPulse(projectPath: string) {
    clearPulseTimer(projectPath);
    setActivelyPulsing((prev) => {
      if (prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.add(projectPath);
      return next;
    });
    const handle = setTimeout(() => {
      pulseTimers.delete(projectPath);
      setActivelyPulsing((prev) => {
        if (!prev.has(projectPath)) return prev;
        const next = new Set(prev);
        next.delete(projectPath);
        return next;
      });
    }, PULSE_DURATION_MS);
    pulseTimers.set(projectPath, handle);
  }

  function stopPulse(projectPath: string) {
    clearPulseTimer(projectPath);
    setActivelyPulsing((prev) => {
      if (!prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.delete(projectPath);
      return next;
    });
  }

  // Track the focus state ourselves — Tauri's `getCurrentWindow().isFocused()`
  // is async, and we need a synchronous read inside the event handler to
  // decide whether to suppress the OS notification.
  const [focused, setFocused] = createSignal<boolean>(true);

  // Provided by App.tsx so we can ask "is this completion for the tab
  // the user is staring at right now?". When it is, we suppress the
  // system notification (sound still plays — the audio cue is friendly
  // even when looking at the screen). When it isn't, we both notify
  // and mark the project unread.
  let isActiveSession: IsActiveSessionFn = () => false;

  function setActiveSessionResolver(fn: IsActiveSessionFn) {
    isActiveSession = fn;
  }

  function markUnread(projectPath: string) {
    setUnread((prev) => {
      if (prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.add(projectPath);
      return next;
    });
    startPulse(projectPath);
  }

  function markRead(projectPath: string) {
    setUnread((prev) => {
      if (!prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.delete(projectPath);
      return next;
    });
    stopPulse(projectPath);
  }

  function isUnread(projectPath: string): boolean {
    return unread().has(projectPath);
  }

  function isPulsing(projectPath: string): boolean {
    return activelyPulsing().has(projectPath);
  }

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
      // Default to focused; on error we'll over-notify slightly rather
      // than silently swallow.
      setFocused(true);
    }
    // onFocusChanged is the documented v2 API. Raw `tauri://focus` /
    // `tauri://blur` events are not guaranteed across platforms; if
    // they don't fire, suppression breaks and we OS-notify for every
    // completion — including ones the user is staring at.
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
    const stareAtIt = focused() && isActiveSession(
      payload.project_path,
      payload.session_id,
    );

    // Sound always plays — gentle audio cue independent of focus state.
    playTaskComplete();

    if (!stareAtIt) {
      // Mark the project as unread so its avatar pulses regardless of
      // whether the OS notification renders. Pure visual signal that
      // can't be blocked by Focus mode or DND.
      markUnread(payload.project_path);

      const title = `${projectName(payload.project_path)} · Claude is done`;
      const body =
        payload.preview && payload.preview.length > 0
          ? payload.preview
          : "Your turn — open Klaudio Panels.";
      void invoke("notify_native", { title, body }).catch(() => {
        // osascript missing or sandbox-blocked — project pulse already
        // covers the visual signal, no need to surface this to the user.
      });
    }
  }

  return {
    isUnread,
    isPulsing,
    markRead,
    markUnread,
    setActiveSessionResolver,
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
