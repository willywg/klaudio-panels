import taskCompleteUrl from "../assets/sounds/task-complete.wav";
import permissionRequestUrl from "../assets/sounds/permission-request.wav";
import { debugLog } from "./debug-log";

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
    void audio.play().catch((e: unknown) => {
      // Webview may block audio if the page hasn't received any user
      // interaction yet (rare in Tauri but not impossible). The native
      // notification + project pulse still convey the signal, but say why
      // the chime was skipped — a silent swallow here is how a missing
      // sound goes undiagnosed.
      const name = e instanceof Error ? e.name : String(e);
      debugLog("sound", `play failed: ${name}`);
    });
  };
}

export const playTaskComplete = makePlayer(taskCompleteUrl);
export const playPermissionRequest = makePlayer(permissionRequestUrl);
