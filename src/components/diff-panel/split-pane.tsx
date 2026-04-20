import { createSignal, onCleanup } from "solid-js";

type Props = {
  /** Current width of the RIGHT pane in px. Parent owns the signal. */
  width: number;
  /** Called live on pointermove while dragging. Parent should update a
   *  signal, not localStorage. */
  onResize: (nextWidth: number) => void;
  /** Called once on pointerup so parent can persist. */
  onResizeEnd: (finalWidth: number) => void;
  /** Element whose right edge defines the 100% x-coordinate. Usually the
   *  SplitPane's parent — we read it on drag to clamp. */
  getParentRect: () => DOMRect;
  minLeft?: number;
  minRight?: number;
};

const DEFAULT_MIN_LEFT = 360;
const DEFAULT_MIN_RIGHT = 300;

/** A 4px vertical drag handle for resizing a right-docked panel. Uses
 *  pointer events + setPointerCapture so the drag survives the cursor
 *  leaving the 4px hit area. */
export function SplitDivider(props: Props) {
  const [dragging, setDragging] = createSignal(false);

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging()) return;
    const rect = props.getParentRect();
    const minLeft = props.minLeft ?? DEFAULT_MIN_LEFT;
    const minRight = props.minRight ?? DEFAULT_MIN_RIGHT;
    const proposed = rect.right - e.clientX;
    const maxRight = rect.width - minLeft;
    const clamped = Math.max(minRight, Math.min(proposed, maxRight));
    props.onResize(clamped);
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging()) return;
    setDragging(false);
    const target = e.currentTarget as HTMLElement;
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    props.onResizeEnd(props.width);
  }

  onCleanup(() => setDragging(false));

  return (
    <div
      class={
        "w-1 cursor-ew-resize shrink-0 transition-colors " +
        (dragging() ? "bg-indigo-500/80" : "bg-neutral-800 hover:bg-indigo-500/60")
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
