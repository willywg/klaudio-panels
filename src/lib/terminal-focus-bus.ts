// Tiny module-level registry that lets tab-strip + new-tab handlers ask a
// specific terminal to take keyboard focus. Sibling of `terminal-scroll-bus`.
//
// Why a registry instead of letting each view focus itself on activation?
// On project re-entry every visible panel's selected tab flips active=true
// simultaneously; if every view called `term.focus()` from its activation
// effect, the last one to run would steal the cursor from the others (see
// #40 / PRP 017). We solve that by only focusing on **explicit user actions**
// — clicking "+" or a tab header — routed through this bus. Passive
// activations (project switch, auto-resume, auto-spawn) don't go through
// here and therefore don't steal focus.
//
// IDs are PTY ids (UUIDs), unique across Claude, shell, and editor PTYs.

const focusers = new Map<string, () => void>();
const pending = new Map<string, number>();

export function registerTerminalFocus(id: string, fn: () => void): void {
  focusers.set(id, fn);
  const timer = pending.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pending.delete(id);
    fn();
  }
}

export function unregisterTerminalFocus(id: string): void {
  focusers.delete(id);
  const timer = pending.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pending.delete(id);
  }
}

/** Focus the terminal with the given PTY id. If the view hasn't mounted yet
 *  (newly-created tab), the request is queued and fires as soon as the view
 *  registers — within a 500ms window. Beyond that the pending entry expires,
 *  on the assumption the tab failed to spawn. */
export function focusTerminal(id: string | null): void {
  if (!id) return;
  const fn = focusers.get(id);
  if (fn) {
    fn();
    return;
  }
  if (pending.has(id)) return;
  const timer = window.setTimeout(() => {
    pending.delete(id);
  }, 500);
  pending.set(id, timer);
}
