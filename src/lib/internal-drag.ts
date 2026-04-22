// Shared signals + event bus for the file-tree → terminal drag flow.
// We can't rely on HTML5 drag-drop anymore because `dragDropEnabled:
// true` lets the NSView capture every drag before the webview sees it
// (needed for Finder drops). So the file tree does a pointer-based
// custom drag: tree-node publishes the hover target here, the
// terminal views subscribe to show their drop overlays, and a
// CustomEvent on `window` delivers the resolved drop to App.tsx.

import { createSignal } from "solid-js";

export type InternalDragState = { path: string; name: string } | null;

const [state, setState] = createSignal<InternalDragState>(null);
const [hoverPtyId, setHoverPtyId] = createSignal<string | null>(null);

export { state as internalDragState, setState as setInternalDragState };
export { hoverPtyId, setHoverPtyId };

export type InternalDropDetail = {
  ptyKind: "claude" | "shell";
  ptyId: string;
  path: string;
};

export const INTERNAL_DROP_EVENT = "klaudio:internal-drop";
