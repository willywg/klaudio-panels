// Tiny module-level registry that lets tab-strip + new-tab handlers ask a
// specific terminal to take keyboard focus, and remembers per-project which
// terminal had focus last so project re-entry can restore it. Sibling of
// `terminal-scroll-bus`.
//
// Why a registry instead of letting each view focus itself on activation?
// On project re-entry every visible panel's selected tab flips active=true
// simultaneously; if every view called `term.focus()` from its activation
// effect, the last one to run would steal the cursor from the others (#40).
// We solve that by only focusing on **explicit user actions** — clicking
// "+" or a tab header, opening a file in an editor PTY — routed through
// this bus, plus a one-shot focus on project switch driven by the
// `lastFocusedForProject` memory below.
//
// The per-project memory is updated in two places:
//   1. Inside `focusTerminal` when the call succeeds (covers user-action
//      activations: "+" / tab header click / Open-in).
//   2. From `recordTerminalFocus`, which views call from a `focus` event
//      listener on `term.textarea`. That catches direct clicks on the
//      xterm body (xterm's native canvas → textarea focus path) as well
//      as anything else that ends up focusing the textarea.
//
// IDs are PTY ids (UUIDs), unique across Claude, shell, and editor PTYs.

type FocusEntry = {
  fn: () => void;
  projectPath: string;
};

const focusers = new Map<string, FocusEntry>();
const pending = new Map<string, number>();
const lastFocusedByProject = new Map<string, string>();

export function registerTerminalFocus(
  id: string,
  projectPath: string,
  fn: () => void,
): void {
  focusers.set(id, { fn, projectPath });
  const timer = pending.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pending.delete(id);
    fn();
    lastFocusedByProject.set(projectPath, id);
  }
}

export function unregisterTerminalFocus(id: string): void {
  const entry = focusers.get(id);
  focusers.delete(id);
  const timer = pending.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pending.delete(id);
  }
  // If the terminal that owned "last focused" for its project just went
  // away, drop the record. Next project switch will fall back to the
  // active Claude tab.
  if (entry && lastFocusedByProject.get(entry.projectPath) === id) {
    lastFocusedByProject.delete(entry.projectPath);
  }
}

/** Focus the terminal with the given PTY id. If the view hasn't mounted yet
 *  (newly-created tab), the request is queued and fires as soon as the view
 *  registers — within a 500ms window. Beyond that the pending entry expires,
 *  on the assumption the tab failed to spawn. */
export function focusTerminal(id: string | null): void {
  if (!id) return;
  const entry = focusers.get(id);
  if (entry) {
    entry.fn();
    lastFocusedByProject.set(entry.projectPath, id);
    return;
  }
  if (pending.has(id)) return;
  const timer = window.setTimeout(() => {
    pending.delete(id);
  }, 500);
  pending.set(id, timer);
}

/** Update the per-project memory without calling focus(). Views invoke this
 *  from a `focus` listener attached to `term.textarea` so direct clicks on
 *  the xterm body (which focus the hidden textarea natively) are tracked. */
export function recordTerminalFocus(id: string): void {
  const entry = focusers.get(id);
  if (!entry) return;
  lastFocusedByProject.set(entry.projectPath, id);
}

export function lastFocusedForProject(projectPath: string): string | undefined {
  return lastFocusedByProject.get(projectPath);
}
