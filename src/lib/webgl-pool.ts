/** How many xterm WebGL contexts stay live in this web process.
 *
 *  Step 0 found no WebKit context cap through 24 terminals, and a full
 *  WebGL terminal costs about 20 MB more than the same terminal on the DOM
 *  renderer. Attach of WebGL onto a hidden, full 10k buffer measured 41 ms
 *  (median of 10, macOS 26.6.2 / WebKit 21624.5.1.11.3), under the 50 ms
 *  line, so the cap is 3: the active agent tab, the active shell tab, and
 *  one recent tab. */
export const WEBGL_POOL_CAP = 3;

export type WebglTouch = {
  /** True when `id` was not already holding a context. */
  attach: boolean;
  /** Oldest ids past the cap. The caller detaches these; the pool does not. */
  detach: string[];
};

export type WebglPool = {
  touch(id: string): WebglTouch;
  release(id: string): void;
  lost(id: string): void;
};

/** LRU of the terminals that currently hold a WebGL addon.
 *
 *  `order` is oldest-first. `touch` moves `id` to the front of the recency
 *  list (the end) and, once `order` is longer than `cap`, returns the ids
 *  that fell off. `lost` drops an id whose context WebKit already took, so
 *  the next `touch` attaches again. `release` is unmount. */
export function createWebglPool(cap: number): WebglPool {
  const order: string[] = [];

  function drop(id: string): void {
    const at = order.indexOf(id);
    if (at !== -1) order.splice(at, 1);
  }

  return {
    touch(id) {
      const already = order.includes(id);
      drop(id);
      order.push(id);
      const detach: string[] = [];
      while (order.length > cap) {
        const oldest = order.shift();
        if (oldest !== undefined) detach.push(oldest);
      }
      return { attach: !already, detach };
    },
    release(id) {
      drop(id);
    },
    lost(id) {
      drop(id);
    },
  };
}

export const webglPool = createWebglPool(WEBGL_POOL_CAP);

/** Surfaces register the function that disposes their own addon. `touch`
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
