import { createSignal, onCleanup, onMount, type JSX } from "solid-js";

/** Gap between the trigger and the panel, in px. */
const OFFSET = 4;

/**
 * Open/close state and placement for a titlebar dropdown whose panel is
 * portalled to `<body>` and positioned `fixed`.
 *
 * The portal is not a style choice. An `absolute` panel inside the titlebar
 * rendered *underneath* the Git panel's rows even though the panel was `z-50`
 * against their `z-10`, and giving the titlebar its own stacking context did
 * not change it — once two subtrees land in different compositing layers the
 * painted order stops following z-index. Leaving the header's subtree removes
 * the shared ancestor that was getting the ordering wrong.
 *
 * Consequences the caller must respect, both handled here:
 *  - outside-click has to test the trigger *and* the portalled panel, since
 *    the panel is no longer a descendant of the trigger's wrapper;
 *  - the anchor rect is captured at open time, so a window resize invalidates
 *    it — we close instead of chasing it.
 */
export function useAnchoredPanel() {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  let trigger: HTMLElement | undefined;
  let panel: HTMLElement | undefined;

  const triggerRef = (el: HTMLElement) => {
    trigger = el;
  };
  const panelRef = (el: HTMLElement) => {
    panel = el;
  };

  function openPanel() {
    if (trigger) setAnchor(trigger.getBoundingClientRect());
    setOpen(true);
  }

  function close() {
    setOpen(false);
  }

  function toggle() {
    if (open()) close();
    else openPanel();
  }

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!open() || !(e.target instanceof Node)) return;
      if (trigger?.contains(e.target) || panel?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    });
  });

  /** Right-aligned to the trigger, hanging just below it. */
  const style = (): JSX.CSSProperties => {
    const r = anchor();
    if (!r) return {};
    return {
      top: `${r.bottom + OFFSET}px`,
      right: `${Math.max(0, window.innerWidth - r.right)}px`,
    };
  };

  return { open, anchor, toggle, close, triggerRef, panelRef, style };
}
