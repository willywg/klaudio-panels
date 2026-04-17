// Shape of events emitted by `claude -p --output-format stream-json --verbose`.
// Captured empirically from claude 2.1.112 — not a formal contract.

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
};
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export type SystemInit = {
  type: "system";
  subtype: "init";
  cwd?: string;
  session_id: string;
  model?: string;
  tools?: string[];
};

export type SystemHook = {
  type: "system";
  subtype: "hook_started" | "hook_response" | string;
  session_id: string;
};

export type AssistantEvent = {
  type: "assistant";
  session_id: string;
  message: {
    role: "assistant";
    content: ContentBlock[];
    usage?: Record<string, unknown>;
    model?: string;
  };
};

export type UserEvent = {
  type: "user";
  session_id: string;
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
};

export type ResultEvent = {
  type: "result";
  subtype: "success" | "error" | string;
  session_id: string;
  is_error?: boolean;
  total_cost_usd?: number;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
};

export type RateLimitEvent = {
  type: "rate_limit_event";
  session_id: string;
  rate_limit_info?: unknown;
};

export type ClaudeEvent =
  | SystemInit
  | SystemHook
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | RateLimitEvent
  | { type: string; session_id?: string; [k: string]: unknown };

export type SessionMeta = {
  id: string;
  timestamp: string | null;
  first_message_preview: string | null;
  project_path: string;
};
