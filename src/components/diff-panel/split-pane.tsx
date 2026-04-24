import { createSignal, onCleanup } from "solid-js";

type Props = {
  /** Which side of the parent row this divider controls. Determines whether
   *  the drag distance grows from the left edge (e.g. a left-docked sidebar)
   *  or from the right edge (e.g. the right-docked diff panel). Defaults to
   *  "right" for backwards compatibility. */
  edge?: "left" | "right";
  /** Current width of the controlled pane in px. Parent owns the signal. */
  width: number;
  /** Called live on pointermove while dragging. Parent should update a
   *  signal, not localStorage. */
  onResize: (nextWidth: number) => void;
  /** Called once on pointerup so parent can persist. */
  onResizeEnd: (finalWidth: number) => void;
  /** Element whose edges define the 100% x-coordinate. Usually the row
   *  that hosts both panes — we read it on drag to clamp. */
  getParentRect: () => DOMRect;
  /** Minimum width for the pane this divider controls. */
  minSelf?: number;
  /** Minimum width reserved for the pane on the OTHER side (typically the
   *  center/terminal column). */
  minOther?: number;
  /** Optional hard ceiling as a fraction of the parent row's width (0–1).
   *  The effective maxSelf is `min(parent.width * maxFraction,
   *  parent.width - minOther)`. Leave undefined to only respect `minOther`. */
  maxFraction?: number;
};

const DEFAULT_MIN_SELF = 300;
const DEFAULT_MIN_OTHER = 360;

/** A 4px vertical drag handle for resizing a side-docked panel. Uses
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
    const minSelf = props.minSelf ?? DEFAULT_MIN_SELF;
    const minOther = props.minOther ?? DEFAULT_MIN_OTHER;
    const edge = props.edge ?? "right";
    const proposed =
      edge === "left" ? e.clientX - rect.left : rect.right - e.clientX;
    const fractionCap =
      props.maxFraction != null
        ? rect.width * props.maxFraction
        : Number.POSITIVE_INFINITY;
    const maxSelf = Math.min(fractionCap, rect.width - minOther);
    const clamped = Math.max(minSelf, Math.min(proposed, maxSelf));
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
        "w-1 cursor-ew-resize shrink-0 select-none transition-colors " +
        (dragging()
          ? "bg-indigo-500/40"
          : "bg-transparent hover:bg-neutral-700/60")
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
