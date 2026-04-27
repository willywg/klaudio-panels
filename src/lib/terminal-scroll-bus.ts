// Tiny module-level registry that lets non-terminal surfaces (e.g. App.tsx's
// global ⌘↓ keymap) ask a specific terminal to scroll its viewport to the
// tail. Each xterm-hosting component (claude PTY, shell PTY) registers its
// own `scrollToBottom` callback on mount keyed by its PTY id; App.tsx calls
// `requestScrollToBottom(id)` for the resolved active terminal.
//
// Module-level (not a Solid context) because:
//   - terminal-view doesn't need reactivity here, just a callback handle
//   - keeps App.tsx's keymap branch synchronous and free of context plumbing
//
// IDs are PTY ids (UUIDs), unique across both Claude and shell PTYs.

const scrollers = new Map<string, () => void>();

export function registerTerminalScroller(id: string, fn: () => void): void {
  scrollers.set(id, fn);
}

export function unregisterTerminalScroller(id: string): void {
  scrollers.delete(id);
}

/** Scrolls the terminal with the given PTY id to its tail. No-op if no
 *  scroller is registered for that id (e.g. tab is unmounted). */
export function requestScrollToBottom(id: string | null): void {
  if (!id) return;
  const fn = scrollers.get(id);
  if (fn) fn();
}
