import {
  createContext,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AssistantEvent,
  ClaudeEvent,
  ContentBlock,
  ResultEvent,
  SystemInit,
  ToolResultBlock,
} from "@/lib/claude-events";

export type TimelineItem =
  | { kind: "init"; session_id: string; cwd?: string; model?: string }
  | { kind: "user"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: unknown;
      result?: { content: string; is_error: boolean };
    }
  | { kind: "result"; cost_usd: number | null; duration_ms: number | null; is_error: boolean };

export type ChatStatus = "idle" | "running" | "error";

type Store = {
  sessionId: string | null;
  status: ChatStatus;
  items: TimelineItem[];
  error: string | null;
};

const initial: Store = {
  sessionId: null,
  status: "idle",
  items: [],
  error: null,
};

export function makeClaudeContext() {
  const [store, setStore] = createStore<Store>({ ...initial });

  const unlistens: UnlistenFn[] = [];

  listen<string>("claude:session", (e) => {
    setStore("sessionId", e.payload);
  }).then((fn) => unlistens.push(fn));

  listen<string>("claude:done", () => {
    setStore("status", (s) => (s === "error" ? "error" : "idle"));
  }).then((fn) => unlistens.push(fn));

  listen<string>("claude:stderr", (e) => {
    console.warn("[claude stderr]", e.payload);
  }).then((fn) => unlistens.push(fn));

  // Single stable channel; Rust only spawns one session at a time so we
  // don't need per-session isolation.
  listen<string>("claude:event", (e) => {
    try {
      const ev = JSON.parse(e.payload) as ClaudeEvent;
      apply(ev);
    } catch (err) {
      console.error("parse event", err, e.payload);
    }
  }).then((fn) => unlistens.push(fn));

  onCleanup(() => {
    for (const fn of unlistens) fn();
  });

  function apply(ev: ClaudeEvent) {
    setStore(
      produce((s) => {
        switch (ev.type) {
          case "system": {
            if ((ev as SystemInit).subtype === "init") {
              const init = ev as SystemInit;
              s.items.push({
                kind: "init",
                session_id: init.session_id,
                cwd: init.cwd,
                model: init.model,
              });
            }
            break;
          }
          case "assistant": {
            const a = ev as AssistantEvent;
            for (const block of a.message.content) {
              pushAssistantBlock(s, block);
            }
            break;
          }
          case "user": {
            // In stream-json, `user` events from the server echo tool_results.
            // We already added the user's own prompt optimistically, so here
            // we only handle tool_result blocks to attach to their tool_use.
            const u = ev as { type: "user"; message: { content: string | ContentBlock[] } };
            if (Array.isArray(u.message.content)) {
              for (const block of u.message.content) {
                if (block.type === "tool_result") {
                  attachToolResult(s, block);
                }
              }
            }
            break;
          }
          case "result": {
            const r = ev as ResultEvent;
            s.items.push({
              kind: "result",
              cost_usd: r.total_cost_usd ?? r.cost_usd ?? null,
              duration_ms: r.duration_ms ?? null,
              is_error: !!r.is_error,
            });
            s.status = "idle";
            break;
          }
          default:
            // ignore hook events, rate_limit_event, file-history-snapshot, etc.
            break;
        }
      }),
    );
  }

  async function send(
    projectPath: string,
    prompt: string,
    model: string,
    resumeSessionId?: string | null,
  ) {
    setStore(
      produce((s) => {
        s.items.push({ kind: "user", text: prompt });
        s.status = "running";
        s.error = null;
        if (!resumeSessionId) {
          // Force re-subscription to pending channel for a fresh session.
          s.sessionId = null;
        }
      }),
    );
    try {
      await invoke("claude_send", {
        projectPath,
        prompt,
        model,
        resumeSessionId: resumeSessionId ?? null,
      });
    } catch (err) {
      setStore("status", "error");
      setStore("error", String(err));
      console.error("claude_send failed", err);
    }
  }

  async function cancel() {
    try {
      await invoke("claude_cancel");
    } finally {
      setStore("status", "idle");
    }
  }

  function reset(opts: { keepSessionId?: boolean } = {}) {
    setStore(
      produce((s) => {
        s.items = [];
        s.status = "idle";
        s.error = null;
        if (!opts.keepSessionId) s.sessionId = null;
      }),
    );
  }

  return { store, send, cancel, reset };
}

function pushAssistantBlock(s: Store, block: ContentBlock) {
  switch (block.type) {
    case "text":
      s.items.push({ kind: "assistant_text", text: block.text });
      break;
    case "thinking":
      s.items.push({ kind: "thinking", text: block.thinking });
      break;
    case "tool_use":
      s.items.push({
        kind: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
      break;
    // tool_result never appears inside assistant.content; ignore
    default:
      break;
  }
}

function attachToolResult(s: Store, block: ToolResultBlock) {
  const entry = s.items.find(
    (it) => it.kind === "tool_use" && it.id === block.tool_use_id,
  );
  if (!entry || entry.kind !== "tool_use") return;
  const text = Array.isArray(block.content)
    ? block.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
    : (block.content ?? "");
  entry.result = { content: text, is_error: !!block.is_error };
}

const Ctx = createContext<ReturnType<typeof makeClaudeContext>>();

export function ClaudeProvider(props: ParentProps) {
  const ctx = makeClaudeContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useClaude() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useClaude outside ClaudeProvider");
  return v;
}
