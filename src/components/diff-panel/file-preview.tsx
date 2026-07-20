import { createEffect, createSignal, onCleanup, onMount, Show, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { BookOpenText, Code2 } from "lucide-solid";
import { useDiffPanel } from "@/context/diff-panel";
import { detectLangFromPath, ensureHighlighter, ensureLangLoaded } from "@/lib/shiki-singleton";
import {
  isMarkdownPath,
  markdownPreviewMode,
  setMarkdownPreviewMode,
} from "@/lib/markdown-preview-prefs";
import { renderMarkdown } from "@/lib/markdown-render";
import { openUrlInSystemBrowser } from "@/lib/open-url";

type FilePayload = {
  path: string;
  contents: string | null;
  is_binary: boolean;
  too_large: boolean;
  bytes: number;
};

type Props = {
  projectPath: string;
  relPath: string;
  line?: number;
};

/** Prose formats read as paragraphs, not code — soft-wrap them instead of
 *  horizontal scrolling. Code files keep `pre` so indentation-heavy lines
 *  (and the mental column ruler) stay intact. */
const PROSE_EXTENSIONS = new Set(["md", "markdown", "mdx", "txt"]);

function isProsePath(relPath: string): boolean {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  return PROSE_EXTENSIONS.has(ext);
}

export function FilePreview(props: Props) {
  const panel = useDiffPanel();
  const [html, setHtml] = createSignal<string>("");
  const [renderedHtml, setRenderedHtml] = createSignal<string>("");
  const [error, setError] = createSignal<string | null>(null);
  const [payload, setPayload] = createSignal<FilePayload | null>(null);
  const [loading, setLoading] = createSignal<boolean>(true);
  // Line jumps (Cmd+click on file:line) land in Source mode regardless of
  // the global preference — Rendered has no line numbers to scroll to. The
  // override is per-view and clears the next time the user picks Rendered.
  const [forceSource, setForceSource] = createSignal<boolean>(!!props.line);
  let codeHost: HTMLDivElement | undefined;
  let scrollHost: HTMLDivElement | undefined;

  const isMd = () => isMarkdownPath(props.relPath);
  const mode = () =>
    isMd() && !forceSource() ? markdownPreviewMode() : "source";

  async function load() {
    setLoading(true);
    setError(null);
    setHtml("");
    setRenderedHtml("");
    try {
      const p = await invoke<FilePayload>("read_file_bytes", {
        projectPath: props.projectPath,
        relPath: props.relPath,
      });
      setPayload(p);
      if (p.contents !== null) {
        const hl = await ensureHighlighter();
        const lang = detectLangFromPath(props.relPath);
        const effective = (await ensureLangLoaded(hl, lang)) ? lang : "text";
        const out = hl.codeToHtml(p.contents, {
          lang: effective,
          theme: "github-dark-default",
        });
        setHtml(out);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    void load();
  });

  // Reload when the file path changes.
  createEffect(
    on(
      () => props.relPath,
      () => {
        void load();
      },
      { defer: true },
    ),
  );

  // A new line jump re-forces Source even if the tab was flipped to
  // Rendered meanwhile.
  createEffect(
    on(
      () => props.line,
      (line) => {
        if (line) setForceSource(true);
      },
      { defer: true },
    ),
  );

  // Global toggle (button or Cmd+Shift+M) choosing Rendered clears the
  // per-view line-jump override — the user explicitly asked for Rendered.
  createEffect(
    on(
      markdownPreviewMode,
      (m) => {
        if (m === "rendered") setForceSource(false);
      },
      { defer: true },
    ),
  );

  // Lazily produce the rendered HTML the first time Rendered mode is shown
  // for the current payload (load() clears the cache).
  createEffect(() => {
    const p = payload();
    if (mode() !== "rendered" || !p?.contents || renderedHtml()) return;
    const src = p.contents;
    void renderMarkdown(src).then((out) => {
      // Payload may have been swapped while we rendered — don't publish
      // stale HTML for a different file.
      if (payload()?.contents === src) setRenderedHtml(out);
    });
  });

  // Scroll to requested line once Shiki HTML is in the DOM. Tracked signals:
  // `html()` so we re-run when the code swaps, `loading()` so we don't target
  // stale DOM, `props.line` so re-opening the same tab with a new line works.
  // Source mode only — Rendered has no `.line` spans.
  createEffect(() => {
    const want = props.line;
    const code = html();
    if (mode() !== "source") return;
    if (!want || !code || !scrollHost || !codeHost || loading()) return;
    let attempts = 0;
    const tryScroll = () => {
      const host = codeHost;
      if (!host) return;
      // Shiki v3 default: `<pre class="shiki"><code><span class="line">…`.
      // Some languages can emit extra wrapper nodes, so match `.line` anywhere
      // under the preview root.
      const lines = host.querySelectorAll<HTMLElement>(".line");
      const target = lines[want - 1];
      if (!target) {
        // DOM not ready yet — retry a couple frames.
        if (attempts++ < 4) requestAnimationFrame(tryScroll);
        return;
      }
      target.scrollIntoView({ block: "center" });
      target.classList.add("preview-line-flash");
      window.setTimeout(
        () => target.classList.remove("preview-line-flash"),
        1200,
      );
      panel.clearFocus();
    };
    requestAnimationFrame(tryScroll);
  });

  onCleanup(() => {
    setHtml("");
    setRenderedHtml("");
  });

  function toggleMode() {
    if (mode() === "source") {
      setForceSource(false);
      setMarkdownPreviewMode("rendered");
    } else {
      setMarkdownPreviewMode("source");
    }
  }

  // The webview must never navigate: absolute links open in the system
  // browser, everything else (relative paths, anchors) is a no-op for now.
  function onRenderedClick(e: MouseEvent) {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) openUrlInSystemBrowser(e, href);
  }

  return (
    <div class="relative h-full w-full flex flex-col min-h-0">
      <Show when={!loading() && payload()?.too_large}>
        <Placeholder text="File exceeds 1 MiB — open externally to view." />
      </Show>
      <Show when={!loading() && payload()?.is_binary}>
        <Placeholder text="Binary file — not shown." />
      </Show>
      <Show when={error()}>
        <Placeholder text={`Couldn't read file: ${error()}`} variant="error" />
      </Show>
      <Show when={loading()}>
        <div class="h-full flex items-center justify-center text-[12px] text-neutral-500">
          Loading…
        </div>
      </Show>
      <Show when={!loading() && !error() && payload()?.contents !== null}>
        <Show when={isMd()}>
          <button
            class="absolute top-2 right-3 z-10 w-7 h-7 rounded-md flex items-center justify-center bg-neutral-900/90 border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition"
            title={
              mode() === "rendered"
                ? "View source (⌘⇧M)"
                : "View rendered (⌘⇧M)"
            }
            onClick={toggleMode}
          >
            <Show
              when={mode() === "rendered"}
              fallback={<BookOpenText size={15} strokeWidth={2} />}
            >
              <Code2 size={15} strokeWidth={2} />
            </Show>
          </button>
        </Show>
        <div
          ref={scrollHost}
          class="flex-1 min-h-0 overflow-auto preview-scroll"
        >
          <Show
            when={mode() === "rendered"}
            fallback={
              <div
                ref={codeHost}
                classList={{
                  "preview-code": true,
                  "preview-wrap": isProsePath(props.relPath),
                }}
                // eslint-disable-next-line solid/no-innerhtml
                innerHTML={html()}
              />
            }
          >
            <Show
              when={renderedHtml()}
              fallback={
                <div class="h-full flex items-center justify-center text-[12px] text-neutral-500">
                  Rendering…
                </div>
              }
            >
              <div
                class="md-rendered"
                onClick={onRenderedClick}
                // eslint-disable-next-line solid/no-innerhtml
                innerHTML={renderedHtml()}
              />
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function Placeholder(props: { text: string; variant?: "error" }) {
  return (
    <div
      class={
        "h-full flex items-center justify-center text-[12px] " +
        (props.variant === "error" ? "text-red-400" : "text-neutral-500")
      }
    >
      {props.text}
    </div>
  );
}
