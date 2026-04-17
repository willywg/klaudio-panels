import { createSignal, For, Show } from "solid-js";
import { useClaude, type TimelineItem } from "@/context/claude";

const DEFAULT_MODEL = "sonnet";

export function ChatView(props: {
  projectPath: string;
  activeSessionId: string | null;
}) {
  const ctx = useClaude();
  const [prompt, setPrompt] = createSignal("");

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    const text = prompt().trim();
    if (!text || ctx.store.status === "running") return;
    setPrompt("");
    await ctx.send(props.projectPath, text, DEFAULT_MODEL, props.activeSessionId);
  }

  return (
    <div class="h-full flex flex-col">
      <header class="border-b border-neutral-800 px-4 py-2 flex items-center gap-3 text-xs text-neutral-400">
        <span class="font-mono">
          {ctx.store.sessionId ?? (props.activeSessionId ?? "—")}
        </span>
        <span
          class={
            "px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider " +
            (ctx.store.status === "running"
              ? "bg-amber-900/40 text-amber-300"
              : ctx.store.status === "error"
              ? "bg-red-900/40 text-red-300"
              : "bg-neutral-800 text-neutral-400")
          }
        >
          {ctx.store.status}
        </span>
        <Show when={ctx.store.status === "running"}>
          <button
            onClick={() => ctx.cancel()}
            class="ml-auto text-xs text-neutral-400 hover:text-red-300"
          >
            Cancelar
          </button>
        </Show>
      </header>

      <div class="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-w-0">
        <Show when={ctx.store.items.length === 0}>
          <div class="text-sm text-neutral-500">
            Sin mensajes todavía. Escribe algo y envía.
          </div>
        </Show>
        <For each={ctx.store.items}>{(item) => <TimelineRow item={item} />}</For>
        <Show when={ctx.store.error}>
          <div class="text-xs text-red-400 font-mono whitespace-pre-wrap">
            {ctx.store.error}
          </div>
        </Show>
      </div>

      <form
        onSubmit={handleSubmit}
        class="border-t border-neutral-800 p-3 flex gap-2"
      >
        <textarea
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
            }
          }}
          placeholder="Mensaje para Claude… (⌘/Ctrl + Enter)"
          class="flex-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-indigo-500"
          rows={2}
          disabled={ctx.store.status === "running"}
        />
        <button
          type="submit"
          disabled={ctx.store.status === "running" || !prompt().trim()}
          class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-800 disabled:text-neutral-500 rounded text-sm font-medium"
        >
          Enviar
        </button>
      </form>
    </div>
  );
}

function TimelineRow(props: { item: TimelineItem }) {
  const i = props.item;
  switch (i.kind) {
    case "init":
      return (
        <div class="text-[11px] text-neutral-500 font-mono">
          session {i.session_id.slice(0, 8)}… · {i.model ?? "model?"}
          {i.cwd ? ` · cwd=${i.cwd}` : ""}
        </div>
      );
    case "user":
      return (
        <div class="bg-indigo-950/40 border border-indigo-900/60 rounded px-3 py-2">
          <div class="text-[10px] uppercase tracking-wider text-indigo-300/80 mb-1">
            Tú
          </div>
          <div class="text-sm whitespace-pre-wrap">{i.text}</div>
        </div>
      );
    case "assistant_text":
      return (
        <div class="bg-neutral-900 border border-neutral-800 rounded px-3 py-2">
          <div class="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
            Claude
          </div>
          <div class="text-sm whitespace-pre-wrap">{i.text}</div>
        </div>
      );
    case "thinking":
      return (
        <div class="border-l-2 border-neutral-700 pl-3 text-xs text-neutral-500 italic whitespace-pre-wrap">
          {i.text}
        </div>
      );
    case "tool_use":
      return (
        <div class="bg-neutral-900/50 border border-neutral-800 rounded px-3 py-2">
          <div class="flex items-baseline gap-2">
            <span class="text-[10px] uppercase tracking-wider text-emerald-400">
              {i.name}
            </span>
            <span class="text-[10px] text-neutral-600 font-mono">
              {i.id.slice(0, 8)}
            </span>
          </div>
          <pre class="mt-1 text-[11px] text-neutral-400 whitespace-pre-wrap font-mono overflow-x-auto">
            {safeStringify(i.input)}
          </pre>
          <Show when={i.result}>
            <div class="mt-2 pt-2 border-t border-neutral-800">
              <div
                class={
                  "text-[10px] uppercase tracking-wider " +
                  (i.result!.is_error ? "text-red-400" : "text-neutral-500")
                }
              >
                {i.result!.is_error ? "error" : "result"}
              </div>
              <pre class="text-[11px] whitespace-pre-wrap font-mono max-h-48 overflow-y-auto text-neutral-300">
                {truncate(i.result!.content, 2000)}
              </pre>
            </div>
          </Show>
        </div>
      );
    case "result":
      return (
        <div class="text-[11px] text-neutral-500 font-mono border-t border-neutral-800 pt-2">
          {i.is_error ? "error · " : "done · "}
          {i.cost_usd !== null ? `$${i.cost_usd.toFixed(4)} · ` : ""}
          {i.duration_ms !== null ? `${(i.duration_ms / 1000).toFixed(1)}s` : ""}
        </div>
      );
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + "\n…";
}
