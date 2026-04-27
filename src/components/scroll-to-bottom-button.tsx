import { Show } from "solid-js";
import { ChevronDown } from "lucide-solid";

/** Floating bottom-right button that appears when the terminal viewport is
 *  scrolled up from the tail. Click → scroll to bottom. Visibility is
 *  controlled by the parent (driven by xterm's `onScroll` event). */
export function ScrollToBottomButton(props: {
  visible: boolean;
  onClick: () => void;
}) {
  return (
    <Show when={props.visible}>
      <button
        type="button"
        class="absolute bottom-3 right-3 w-7 h-7 rounded-full bg-neutral-900/85 hover:bg-neutral-800 border border-neutral-700 text-neutral-300 hover:text-neutral-100 shadow-lg flex items-center justify-center transition backdrop-blur-sm z-10"
        onClick={(e) => {
          e.stopPropagation();
          props.onClick();
        }}
        title="Scroll to bottom (⌘↓)"
      >
        <ChevronDown size={14} strokeWidth={2.25} />
      </button>
    </Show>
  );
}
