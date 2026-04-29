import taskCompleteUrl from "../assets/sounds/task-complete.wav";
import permissionRequestUrl from "../assets/sounds/permission-request.wav";

const VOLUME = 0.35;

function makePlayer(url: string): () => void {
  let audio: HTMLAudioElement | null = null;
  return () => {
    if (!audio) {
      audio = new Audio(url);
      audio.volume = VOLUME;
      audio.preload = "auto";
    }
    try {
      audio.currentTime = 0;
    } catch {
      // currentTime may throw if not yet loaded; ignore.
    }
    void audio.play().catch(() => {
      // Webview may block audio if the page hasn't received any user
      // interaction yet (rare in Tauri but not impossible). Swallow —
      // the native notification + project pulse still convey the signal.
    });
  };
}

export const playTaskComplete = makePlayer(taskCompleteUrl);
export const playPermissionRequest = makePlayer(permissionRequestUrl);
