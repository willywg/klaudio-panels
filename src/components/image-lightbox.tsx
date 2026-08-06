import { Copy, X } from "lucide-solid";
import {
  createEffect,
  createSignal,
  onCleanup,
  on,
  Show,
} from "solid-js";
import {
  closeImageLightbox,
  lightboxPath,
} from "@/lib/image-lightbox-bus";
import {
  formatBytes,
  imageDataUrl,
  loadImage,
  type ImagePayload,
} from "@/lib/image-files";

/** Full-screen image viewer, mounted once at the app root and driven by
 *  `image-lightbox-bus`. Opened from a ⌘-click on an image path in the
 *  terminal, or from the file preview's zoom control. */
export function ImageLightbox() {
  const [payload, setPayload] = createSignal<ImagePayload | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [natural, setNatural] = createSignal<{ w: number; h: number } | null>(
    null,
  );
  /** `fit` scales down to the viewport; `actual` shows 1:1 and scrolls. */
  const [zoom, setZoom] = createSignal<"fit" | "actual">("fit");

  createEffect(
    on(lightboxPath, (path) => {
      setPayload(null);
      setError(null);
      setNatural(null);
      setZoom("fit");
      if (!path) return;
      void loadImage(path)
        .then((p) => {
          // The user may have closed it, or opened a different image, while
          // we were reading — don't publish a payload nobody asked for.
          if (lightboxPath() === path) setPayload(p);
        })
        .catch((err) => {
          if (lightboxPath() === path) setError(String(err));
        });
    }),
  );

  // Esc closes from anywhere. Registered only while open so it can't shadow
  // Esc handling elsewhere in the app (nvim tabs care about this).
  createEffect(() => {
    if (!lightboxPath()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeImageLightbox();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  function copyPath() {
    const p = lightboxPath();
    if (!p) return;
    void navigator.clipboard
      .writeText(payload()?.path ?? p)
      .catch((err) => console.warn("clipboard write failed", err));
  }

  return (
    <Show when={lightboxPath()}>
      {(path) => (
        <div
          class="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex flex-col"
          onClick={closeImageLightbox}
        >
          <div
            class="h-10 shrink-0 flex items-center gap-2 px-3 text-[11px] text-neutral-400"
            onClick={(e) => e.stopPropagation()}
          >
            <span class="font-mono truncate">{payload()?.path ?? path()}</span>
            <Show when={payload()}>
              {(p) => (
                <span class="shrink-0 text-neutral-600">
                  {formatBytes(p().bytes)}
                  <Show when={natural()}>
                    {(n) => (
                      <>
                        {" · "}
                        {n().w}×{n().h}
                      </>
                    )}
                  </Show>
                </span>
              )}
            </Show>
            <div class="flex-1" />
            <button
              onClick={copyPath}
              class="w-7 h-7 rounded flex items-center justify-center hover:text-neutral-100 hover:bg-neutral-800/80 transition"
              title="Copy path"
            >
              <Copy size={14} strokeWidth={2} />
            </button>
            <button
              onClick={closeImageLightbox}
              class="w-7 h-7 rounded flex items-center justify-center hover:text-neutral-100 hover:bg-neutral-800/80 transition"
              title="Close (Esc)"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>

          <div class="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4">
            <Show when={error()}>
              <span class="text-[12px] text-red-400 font-mono">{error()}</span>
            </Show>
            <Show when={!error() && !payload()}>
              <span class="text-[12px] text-neutral-500">Loading…</span>
            </Show>
            <Show when={payload()}>
              {(p) => (
                <img
                  src={imageDataUrl(p())}
                  alt={p().path}
                  onLoad={(e) =>
                    setNatural({
                      w: e.currentTarget.naturalWidth,
                      h: e.currentTarget.naturalHeight,
                    })
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoom((z) => (z === "fit" ? "actual" : "fit"));
                  }}
                  classList={{
                    "cursor-zoom-in": zoom() === "fit",
                    "cursor-zoom-out": zoom() === "actual",
                    "max-w-full max-h-full object-contain": zoom() === "fit",
                  }}
                />
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
