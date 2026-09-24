/** How many xterm WebGL contexts stay live in this web process.
 *
 *  Step 0 found no WebKit context cap through 24 terminals, and a full
 *  WebGL terminal costs about 20 MB more than the same terminal on the DOM
 *  renderer. Attach of WebGL onto a hidden, full 10k buffer measured 41 ms
 *  (median of 10, macOS 26.6.2 / WebKit 21624.5.1.11.3), under the 50 ms
 *  line, so the cap is 3: the active agent tab, the active shell tab, and
 *  one recent tab. Visible terminals are never the ones dropped — a shell
 *  panel or an editor that is still on screen keeps its context no matter
 *  how many agent tabs are switched. If every holder is visible the pool
 *  may sit above the cap. */
export const WEBGL_POOL_CAP = 3;

export type WebglShow = {
  /** True when `id` holds no context yet. */
  attach: boolean;
  /** Hidden ids past the cap, oldest first. The caller detaches these. */
  detach: string[];
};

export type WebglPool = {
  show(id: string): WebglShow;
  hide(id: string): void;
  release(id: string): void;
  lost(id: string): void;
};

/** LRU of the terminals that currently hold a WebGL addon.
 *
 *  `order` is oldest-first and only lists ids that hold a context.
 *  `visible` is whoever is on screen, whether or not they hold one.
 *  `show` marks `id` visible and newest. Eviction then walks from the
 *  oldest holder and only takes ids that are not visible. `hide` leaves
 *  the context in place so a panel that is still open is not a candidate
 *  the next time an agent tab changes. `lost` drops a context WebKit
 *  already took; the id stays visible, so the next `show` attaches again.
 *  `release` is unmount. */
export function createWebglPool(cap: number): WebglPool {
  const order: string[] = [];
  const visible = new Set<string>();

  function drop(id: string): void {
    const at = order.indexOf(id);
    if (at !== -1) order.splice(at, 1);
  }

  function evictHidden(): string[] {
    const detach: string[] = [];
    while (order.length > cap) {
      const at = order.findIndex((id) => !visible.has(id));
      if (at === -1) break;
      const oldest = order.splice(at, 1)[0];
      if (oldest !== undefined) detach.push(oldest);
    }
    return detach;
  }

  return {
    show(id) {
      const already = order.includes(id);
      visible.add(id);
      drop(id);
      order.push(id);
      return { attach: !already, detach: evictHidden() };
    },
    hide(id) {
      visible.delete(id);
    },
    release(id) {
      visible.delete(id);
      drop(id);
    },
    lost(id) {
      drop(id);
    },
  };
}

export const webglPool = createWebglPool(WEBGL_POOL_CAP);

/** Surfaces register the function that disposes their own addon. `show`
 *  only returns ids; the caller asks the registry to run those detaches,
 *  because one activation has to drop a context that lives in another view. */
const detachers = new Map<string, () => void>();

export function registerWebglDetacher(id: string, detach: () => void): void {
  detachers.set(id, detach);
}

export function unregisterWebglDetacher(id: string): void {
  detachers.delete(id);
}

export function runWebglDetaches(ids: string[]): void {
  for (const id of ids) detachers.get(id)?.();
}
