import {
  createContext,
  createEffect,
  createSignal,
  on,
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

// Pulse the avatar ring for ~3 cycles (~4.5s @ 1.5s per cycle) of
// **focused** time. The timer only counts down while the window is in
// the foreground — if the user is in another app when the completion
// fires, the pulse stays animated until they alt-tab back, then runs
// the full 4.5s while they're looking. Otherwise the pulse would expire
// silently behind their back and they'd land on a steady ring with no
// memory of it ever animating.
const PULSE_DURATION_MS = 4500;

function makeNotificationsContext() {
  // Three-tier visual state:
  // - `unread`: steady amber ring, cleared only on markRead.
  // - `activelyPulsing`: animate-pulse class, cleared by the timer or
  //   markRead. Survives blur (timer pauses); resumes when focus returns.
  // - `pulseTimers`: live timeouts. Cleared on blur, re-scheduled on focus.
  const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set());
  const [activelyPulsing, setActivelyPulsing] = createSignal<ReadonlySet<string>>(new Set());
  const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Tracked synchronously so handleComplete can decide suppression
  // without an async round-trip. Defaults to true; if onMount races a
  // completion we'd rather over-pulse briefly than silently swallow.
  const [focused, setFocused] = createSignal<boolean>(true);

  function clearPulseTimer(projectPath: string) {
    const t = pulseTimers.get(projectPath);
    if (t !== undefined) {
      clearTimeout(t);
      pulseTimers.delete(projectPath);
    }
  }

  function schedulePulseTimer(projectPath: string) {
    clearPulseTimer(projectPath);
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

  function startPulse(projectPath: string) {
    setActivelyPulsing((prev) => {
      if (prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.add(projectPath);
      return next;
    });
    // Only count down while the user can see it. Blur cancels timers;
    // the focus-watcher effect below re-schedules them on focus return.
    if (focused()) schedulePulseTimer(projectPath);
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

  // When focus changes, sync the timer state with the visual state:
  // - blur: pause every running timer (keep projects in activelyPulsing).
  // - focus: schedule a fresh timer for every project still pulsing.
  // Re-scheduling gives the user the full PULSE_DURATION_MS of "looking
  // at it" time on every focus return, which matches the UX intent
  // ("the eye-catch should run while you're actually looking").
  createEffect(
    on(focused, (now, prev) => {
      if (prev === undefined) return; // skip initial run
      if (!now) {
        for (const path of pulseTimers.keys()) {
          clearTimeout(pulseTimers.get(path)!);
        }
        pulseTimers.clear();
      } else {
        for (const path of activelyPulsing()) {
          schedulePulseTimer(path);
        }
      }
    }),
  );

  // Push the count of unread projects into the macOS Dock badge so the
  // user gets at-a-glance "you have N projects waiting" awareness even
  // when Klaudio is buried behind other windows. Cleared (badge hidden)
  // when the count drops to zero.
  createEffect(() => {
    const count = unread().size;
    void invoke("set_dock_badge", { count }).catch(() => {
      // Non-macOS or API unavailable — silent fallback, the in-app
      // ring/pulse already cover the indicator on the same machine.
    });
  });

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
