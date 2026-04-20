import { createEffect, createSignal, onCleanup, onMount, Show, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useDiffPanel } from "@/context/diff-panel";
import { detectLangFromPath, ensureHighlighter, ensureLangLoaded } from "@/lib/shiki-singleton";

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

export function FilePreview(props: Props) {
  const panel = useDiffPanel();
  const [html, setHtml] = createSignal<string>("");
  const [error, setError] = createSignal<string | null>(null);
  const [payload, setPayload] = createSignal<FilePayload | null>(null);
  const [loading, setLoading] = createSignal<boolean>(true);
  let codeHost: HTMLDivElement | undefined;
  let scrollHost: HTMLDivElement | undefined;

  async function load() {
    setLoading(true);
    setError(null);
    setHtml("");
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

  // Scroll to requested line once Shiki HTML is in the DOM. Tracked signals:
  // `html()` so we re-run when the code swaps, `loading()` so we don't target
  // stale DOM, `props.line` so re-opening the same tab with a new line works.
  createEffect(() => {
    const want = props.line;
    const code = html();
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
  });

  return (
    <div class="h-full w-full flex flex-col min-h-0">
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
        <div
          ref={scrollHost}
          class="flex-1 min-h-0 overflow-auto preview-scroll"
        >
          <div
            ref={codeHost}
            class="preview-code"
            // eslint-disable-next-line solid/no-innerhtml
            innerHTML={html()}
          />
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
