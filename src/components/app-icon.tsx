import { Show } from "solid-js";
import { useOpenIn } from "@/context/open-in";
import type { OpenInApp } from "@/lib/open-in";

type Props = {
  app: OpenInApp;
  /** Pixel size for the square. Defaults to 14. */
  size?: number;
  /** Extra classes for layout (e.g. "shrink-0"). */
  class?: string;
};

/** Renders the real `.app` icon extracted from macOS when available, falling
 *  back to the app's Lucide icon otherwise. All three dropdowns/submenus use
 *  this component so there's one place to tune sizing. */
export function AppIcon(props: Props) {
  const openIn = useOpenIn();
  const size = () => props.size ?? 14;
  const url = () => openIn.iconUrlFor(props.app.id);

  return (
    <Show
      when={url()}
      fallback={(() => {
        const Icon = props.app.icon;
        return (
          <Icon
            size={size()}
            strokeWidth={2}
            class={"shrink-0 " + props.app.color + (props.class ? " " + props.class : "")}
          />
        );
      })()}
    >
      {(src) => (
        <img
          src={src()}
          alt={props.app.label}
          width={size()}
          height={size()}
          class={"shrink-0 rounded-sm" + (props.class ? " " + props.class : "")}
          style={{
            width: `${size()}px`,
            height: `${size()}px`,
            "image-rendering": "-webkit-optimize-contrast",
          }}
        />
      )}
    </Show>
  );
}
