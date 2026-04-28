import taskCompleteUrl from "../assets/sounds/task-complete.wav";

const VOLUME = 0.35;

let audio: HTMLAudioElement | null = null;

function instance(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(taskCompleteUrl);
    audio.volume = VOLUME;
    audio.preload = "auto";
  }
  return audio;
}

export function playTaskComplete(): void {
  const a = instance();
  try {
    a.currentTime = 0;
  } catch {
    // currentTime may throw if not yet loaded; ignore.
  }
  void a.play().catch(() => {
    // Webview may block audio if the page hasn't received any user
    // interaction yet (rare in Tauri but not impossible). Swallow —
    // the native notification + project pulse still convey the signal.
  });
}
