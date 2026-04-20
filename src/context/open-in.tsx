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
  getLastOpenInApp,
  setLastOpenInApp,
  type OpenInApp,
} from "@/lib/open-in";

function makeOpenInContext() {
  /** Per-app detection result. `undefined` while probing. Finder is always true. */
  const [exists, setExists] = createStore<Record<string, boolean | undefined>>({
    [FINDER_APP.id]: true,
  });
  const [lastAppId, setLastAppIdSignal] = createSignal<string>(getLastOpenInApp());

  onMount(() => {
    void (async () => {
      const results = await Promise.all(
        MAC_APPS.map(async (app) => {
          try {
            const ok = await invoke<boolean>("check_app_exists", {
              appName: app.openWith,
            });
            return [app.id, ok] as const;
          } catch {
            return [app.id, false] as const;
          }
        }),
      );
      for (const [id, ok] of results) setExists(id, ok);
    })();
  });

  createEffect(() => {
    setLastOpenInApp(lastAppId());
  });

  function setLastApp(id: string) {
    setLastAppIdSignal(id);
  }

  /** Apps that exist on this machine, in MAC_APPS order, with Finder first. */
  function availableApps(): OpenInApp[] {
    const out: OpenInApp[] = [FINDER_APP];
    for (const a of MAC_APPS) {
      if (exists[a.id]) out.push(a);
    }
    return out;
  }

  function resolveCurrent(): OpenInApp {
    const id = lastAppId();
    const list = availableApps();
    return list.find((a) => a.id === id) ?? FINDER_APP;
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
