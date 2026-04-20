import {
  createContext,
  createEffect,
  createSignal,
  onMount,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import {
  FINDER_APP,
  MAC_APPS,
  TERMINAL_EDITOR_APPS,
  getLastOpenInApp,
  setLastOpenInApp,
  getDefaultTerminalEditorId,
  setDefaultTerminalEditorId,
  type OpenInApp,
} from "@/lib/open-in";

function makeOpenInContext() {
  /** Per-app detection result. `undefined` while probing. Finder is always true. */
  const [exists, setExists] = createStore<Record<string, boolean | undefined>>({
    [FINDER_APP.id]: true,
  });
  /** Real .app icon rendered to a PNG data URL. Populated lazily per app
   *  after `check_app_exists` reports the app is present. `undefined` =
   *  not yet fetched; `null` = fetch failed (fall back to Lucide). */
  const [iconUrls, setIconUrls] = createStore<
    Record<string, string | null | undefined>
  >({});
  const [lastAppId, setLastAppIdSignal] = createSignal<string>(getLastOpenInApp());
  const [defaultEditorId, setDefaultEditorIdSignal] = createSignal<string | null>(
    getDefaultTerminalEditorId(),
  );

  async function hydrateIcon(app: OpenInApp) {
    // Finder ships as a system app — fetch its icon too so the dropdown avatar
    // is the real Finder blue/teal face.
    try {
      const url = await invoke<string>("get_app_icon", {
        appName: app.openWith,
      });
      setIconUrls(app.id, url);
    } catch {
      setIconUrls(app.id, null);
    }
  }

  onMount(() => {
    // Finder's .app lives under /System/Library/CoreServices so the usual
    // /Applications probe misses it. We still fetch the icon through
    // NSWorkspace which resolves it from the bundle identifier.
    void hydrateIcon(FINDER_APP);

    void (async () => {
      const guiResults = await Promise.all(
        MAC_APPS.map(async (app) => {
          try {
            const ok = await invoke<boolean>("check_app_exists", {
              appName: app.openWith,
            });
            return [app, ok] as const;
          } catch {
            return [app, false] as const;
          }
        }),
      );
      for (const [app, ok] of guiResults) {
        setExists(app.id, ok);
        if (ok) void hydrateIcon(app);
      }
    })();

    // Terminal editors live on the hydrated shell PATH, not in /Applications.
    // Probe them via a separate Rust command so homebrew / nvm / asdf hits
    // don't need to be faked through the .app-bundle detector.
    void (async () => {
      const editorResults = await Promise.all(
        TERMINAL_EDITOR_APPS.map(async (app) => {
          try {
            const ok = await invoke<boolean>("check_binary_exists", {
              binary: app.openWith,
            });
            return [app, ok] as const;
          } catch {
            return [app, false] as const;
          }
        }),
      );
      for (const [app, ok] of editorResults) {
        setExists(app.id, ok);
        // No NSWorkspace icon for bare binaries — the Lucide fallback renders.
      }
    })();
  });

  createEffect(() => {
    setLastOpenInApp(lastAppId());
  });

  function setLastApp(id: string) {
    setLastAppIdSignal(id);
  }

  function setDefaultEditor(id: string | null) {
    setDefaultEditorIdSignal(id);
    setDefaultTerminalEditorId(id);
  }

  /** The user's preferred terminal editor for Cmd+click — returns the
   *  OpenInApp if it's still detected on PATH, else falls through to the
   *  first available terminal editor, else null (nothing to open with). */
  function resolveDefaultEditor(): OpenInApp | null {
    const id = defaultEditorId();
    const editors = TERMINAL_EDITOR_APPS.filter((a) => exists[a.id]);
    if (editors.length === 0) return null;
    return editors.find((a) => a.id === id) ?? editors[0];
  }

  /** Apps that exist on this machine, in MAC_APPS order, with Finder first,
   *  followed by terminal editors that resolve on the shell PATH. */
  function availableApps(): OpenInApp[] {
    const out: OpenInApp[] = [FINDER_APP];
    for (const a of MAC_APPS) {
      if (exists[a.id]) out.push(a);
    }
    for (const a of TERMINAL_EDITOR_APPS) {
      if (exists[a.id]) out.push(a);
    }
    return out;
  }

  function resolveCurrent(): OpenInApp {
    const id = lastAppId();
    const list = availableApps();
    const match = list.find((a) => a.id === id);
    // Terminal editors are never a valid "default" for the dropdown's primary
    // button — they open files in a PTY and need a project-scoped caller,
    // whereas the dropdown operates on a project directory. Fall through to
    // the first GUI app (Finder is always present) if someone set lastAppId
    // to an editor id.
    if (match && !match.terminalEditor) return match;
    return list.find((a) => !a.terminalEditor) ?? FINDER_APP;
  }

  /** Real .app icon URL (PNG data URL) if available; otherwise `null`. */
  function iconUrlFor(appId: string): string | null {
    const v = iconUrls[appId];
    return typeof v === "string" ? v : null;
  }

  async function openPath(absPath: string, appId?: string): Promise<void> {
    const id = appId ?? lastAppId();
    if (id !== lastAppId()) setLastApp(id);
    const app = availableApps().find((a) => a.id === id) ?? FINDER_APP;
    const appNameArg = app.id === FINDER_APP.id ? null : app.openWith;
    try {
      await invoke("open_path_with", {
        path: absPath,
        appName: appNameArg,
      });
    } catch (err) {
      console.warn("open_path_with failed", err);
      throw err;
    }
  }

  return {
    exists,
    availableApps,
    lastAppId,
    setLastApp,
    resolveCurrent,
    openPath,
    iconUrlFor,
    defaultEditorId,
    setDefaultEditor,
    resolveDefaultEditor,
  };
}

const Ctx = createContext<ReturnType<typeof makeOpenInContext>>();

export function OpenInProvider(props: ParentProps) {
  const ctx = makeOpenInContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useOpenIn() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOpenIn outside OpenInProvider");
  return v;
}
