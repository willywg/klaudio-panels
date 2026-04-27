// Pointer-based custom drag for "publish a file path to a Claude / shell PTY".
// Used by the file tree (rows) and the diff-panel preview (tabs).
//
// Why custom instead of HTML5 drag: Tauri's `dragDropEnabled: true` lets the
// NSView capture every drag before the webview sees it (needed so OS Finder
// drops still work). HTML5 dragstart never fires inside the webview. Pointer
// events bypass that capture cleanly.
//
// Contract: caller supplies a `source()` accessor returning the absolute
// path + a display label (or null when this row/tab isn't draggable, e.g.
// the "Git changes" diff tab). The hook owns ghost rendering, threshold
// detection, hover-target tracking, and drop dispatch via the shared
// INTERNAL_DROP_EVENT bus consumed in App.tsx.

import {
  INTERNAL_DROP_EVENT,
  type InternalDropDetail,
  setHoverPtyId,
  setInternalDragState,
} from "@/lib/internal-drag";

const DRAG_THRESHOLD_PX = 5;

export type InternalDragSource = () => { path: string; label: string } | null;

function buildGhost(label: string): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    "z-index:9999",
    "padding:4px 8px",
    "border-radius:6px",
    "background:rgba(79,70,229,0.92)",
    "color:#fff",
    "font-size:12px",
    "font-family:ui-sans-serif,system-ui",
    "box-shadow:0 4px 10px rgba(0,0,0,0.3)",
    "transform:translate(10px,10px)",
    "max-width:260px",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "white-space:nowrap",
  ].join(";");
  return el;
}

export function createInternalDrag(source: InternalDragSource) {
  let pressStart: { x: number; y: number } | null = null;
  let dragging = false;
  let didDrag = false;
  let ghost: HTMLDivElement | null = null;

  function cleanup() {
    ghost?.remove();
    ghost = null;
    dragging = false;
    pressStart = null;
    setInternalDragState(null);
    setHoverPtyId(null);
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    pressStart = { x: e.clientX, y: e.clientY };
    didDrag = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!pressStart) return;
    if (!dragging) {
      const dx = e.clientX - pressStart.x;
      const dy = e.clientY - pressStart.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      const s = source();
      if (!s) {
        // Caller declined to drag — abort the gesture without a ghost.
        pressStart = null;
        return;
      }
      dragging = true;
      didDrag = true;
      ghost = buildGhost(s.label);
      document.body.appendChild(ghost);
      setInternalDragState({ path: s.path, name: s.label });
    }
    if (ghost) {
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
    }
    // Update the drop target highlight. elementFromPoint returns the
    // topmost CSS-painted element under the coords; walk up to find
    // whichever terminal host is advertising its pty id.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const host =
      under instanceof Element
        ? under.closest<HTMLElement>("[data-pty-id]")
        : null;
    setHoverPtyId(host?.dataset.ptyId ?? null);
  }

  function onPointerUp(e: PointerEvent) {
    if (!pressStart) {
      cleanup();
      return;
    }
    if (dragging) {
      const s = source();
      if (s) {
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const host =
          under instanceof Element
            ? under.closest<HTMLElement>("[data-pty-id]")
            : null;
        const kind = host?.dataset.ptyKind;
        const ptyId = host?.dataset.ptyId;
        if (host && (kind === "claude" || kind === "shell") && ptyId) {
          const detail: InternalDropDetail = {
            ptyKind: kind,
            ptyId,
            path: s.path,
          };
          window.dispatchEvent(
            new CustomEvent<InternalDropDetail>(INTERNAL_DROP_EVENT, {
              detail,
            }),
          );
        }
      }
    }
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore — capture may have been lost
    }
    cleanup();
    // The click event fires right after pointerup; let the flag linger
    // one frame so onClick can read it via consumedClick() and skip its
    // default behavior.
    requestAnimationFrame(() => {
      didDrag = false;
    });
  }

  function onPointerCancel() {
    cleanup();
  }

  /** True between pointerup and the next animation frame when the gesture
   *  was actually a drag (not a click). Caller's onClick should bail when
   *  this is true so a tab activation / row select doesn't fire on drop. */
  function consumedClick(): boolean {
    return didDrag;
  }

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
    consumedClick,
  };
}
