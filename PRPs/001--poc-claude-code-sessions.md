# PRP: PoC — Claude Code sessions in Tauri

> **Version:** 1.0
> **Created:** 2026-04-16
> **Status:** Ready
> **Phase:** Sprint 01 (pre-Phase 1 of PROJECT.md)

---

## Goal

Show, in 3–5 days, that we can spawn `claude -p --output-format stream-json --verbose` from a Tauri v2 + SolidJS app, list the existing sessions of a project (reading `~/.claude/projects/`), and render the stream-json events in a minimal UI — with the ability to create a new session, continue an existing one (`--resume <id>`), and cancel the process. No file tree, no diff, no free-form terminal, no polished markdown.

## Why

- **Unblocks everything else.** If the primary channel (stream-json) does not work reliably inside Tauri, the whole PROJECT.md plan collapses. This PoC validates that with real code, not assumptions.
- **Reduces architectural risk early.** Before investing in file tree, diff viewer, or terminal, we confirm that the key assumptions (path encoding, stream-json flushing, process kill) hold.
- **Ships a working "product" already.** Even as a PoC, it lets the user open a project, resume old conversations, and start a new one — useful even without the rest.

## What

A Tauri window with a 2-screen flow:

1. **Initial screen** — "Open project" button (native directory dialog).
2. **Main layout (2 columns)** — left sidebar with the project's session list + "New session" button; right panel with the chat view (header with session_id, event timeline, input).

### Success Criteria
- [ ] The app opens with `bun tauri dev` without Tauri/Vite warnings.
- [ ] I pick a project that already exists in `~/.claude/projects/` and I see its sessions listed with date + first-user-message preview.
- [ ] Click "New session" + type a prompt → I see streaming events (system/init, tool_use, assistant, tool_result, result) in order.
- [ ] Click on an existing session + send a message → `--resume <id>` makes Claude respond with the previous conversation's context.
- [ ] Click "Cancel" while running → the process dies (verifiable with `ps aux | grep claude`).
- [ ] Reload the app (Cmd+R) and it remembers the last chosen project.
- [ ] The just-created session shows up in the sidebar on refresh.
- [ ] `cargo check` + `bun run typecheck` pass without errors.

---

## All Needed Context

### Project-level references (always relevant)
```yaml
- file: PROJECT.md
  why: Full blueprint, hybrid strategy, chosen stack
- file: CLAUDE.md
  why: Non-negotiable rules (chat via pipes not PTY, sessions under ~/.claude/projects, etc.)
- file: docs/sprint-01-poc.md
  why: Sprint scope, 9-step user flow that acts as acceptance test, risks table
```

### Feature-specific references
```yaml
# CLAUDIA — main reference for Claude Code integration
- file: ~/proyectos/open-source/claudia/src-tauri/src/claude_binary.rs
  why: `claude` detection (which + fallbacks + version validation)
  lines: 35-200

- file: ~/proyectos/open-source/claudia/src-tauri/src/commands/claude.rs
  why: spawn_claude_process — exact pattern for per-session stream-json emission
  lines: 1174-1290
  critical: |
    - Capture session_id from the first `system`/`init` event, NOT earlier
    - Emit on `claude-output:{session_id}` + a generic channel for backward compat
    - Kill the existing process before spawning a new one (single-session model)

- file: ~/proyectos/open-source/claudia/src-tauri/src/commands/claude.rs
  why: extract_first_user_message + list_projects — JSONL parsing
  lines: 180-330
  critical: |
    - Skip messages starting with <command-name>, <local-command-stdout>
    - Skip if the content contains "Caveat: The messages below were generated..."
    - get_project_path_from_sessions reads cwd from the JSONL (does not decode the dir name)

# OPENCODE — useful pattern for process kill
- file: ~/proyectos/open-source/opencode/packages/desktop/src-tauri/src/cli.rs
  why: process-wrap ProcessGroup::leader() to kill the whole group
  lines: 471-479
  critical: "Without this, killing the child leaves zombies when claude spawns subprocesses (Bash tool)"

# Official docs
- url: https://docs.anthropic.com/en/docs/claude-code/sdk
  why: Claude Code SDK docs — confirms -p, --output-format stream-json, --resume, -c flags
  critical: stream-json emits one JSON object per line, terminated with \n

- url: https://v2.tauri.app/reference/javascript/api/namespaceevent/
  why: listen/emit for stream-like events

- url: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/dialog
  why: plugin-dialog open({ directory: true })
```

### Current repo state
```
claude-desktop/
├── .claude/
├── .git/
├── CLAUDE.md
├── PROJECT.md
├── PRPs/
│   ├── templates/prp_base.md
│   └── 001--poc-claude-code-sessions.md   # ← this file
└── docs/sprint-01-poc.md
```

**There is no scaffolding yet.** The first task creates it.

### Desired structure after this PRP
```
claude-desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs              # Tauri setup, registers commands, plugins
│       ├── binary.rs           # `claude` detection on PATH
│       ├── sessions.rs         # Parse ~/.claude/projects/**/*.jsonl
│       └── claude.rs           # Stream-json spawn + per-session emit
├── src/
│   ├── App.tsx                 # 2-column layout + project/chat switcher
│   ├── main.tsx                # Entry
│   ├── index.css               # Tailwind v4 base
│   ├── context/
│   │   └── claude.tsx          # Store + event listener
│   ├── components/
│   │   ├── project-picker.tsx  # Empty state + dialog trigger
│   │   ├── sessions-list.tsx   # Sidebar with sessions + "New" button
│   │   ├── chat-view.tsx       # Event timeline + input
│   │   ├── message-user.tsx
│   │   ├── message-assistant.tsx
│   │   ├── tool-call.tsx
│   │   ├── tool-result.tsx
│   │   └── result-summary.tsx
│   └── lib/
│       ├── claude-events.ts    # Stream-json types
│       └── bindings.ts         # Typed invoke() wrappers
├── package.json
├── vite.config.ts
├── tsconfig.json
└── tailwind.config.ts (if v4 requires it; may be just @import)
```

### Known gotchas & project rules

```
FROM CLAUDE.md (NON-NEGOTIABLE):
- Chat = piped subprocess + JSON line parsing. NO PTY.
- Sessions live in ~/.claude/projects/ — do NOT create parallel storage.
- Filesystem + git = source of truth; no custom index.
- Don't copy OpenCode's cli.rs or terminal.tsx patterns for the chat.

CLAUDE CLI BEHAVIOR:
- `claude -p "<prompt>"` is one-shot. Every turn spawns a new process.
- For multi-turn: pass --resume <session_id> from the previous turn.
- First time (new session): omit --resume; `session_id` arrives in
  the first `system`/`init` event on stdout.
- --dangerously-skip-permissions exists but we do NOT use it in the PoC —
  we want to see the real permission prompts.
- The `claude` binary must be authenticated (the user has run `claude`
  at least once). If not, `-p` exits with an error — we show it raw.

PATH ENCODING:
- ~/.claude/projects/ uses dir names like "-Users-willywg-proyectos-X".
- It is NOT reversible if the original path contains "-". Example:
  "-Users-mufeed-dev-jsonl-viewer" could be
  "/Users/mufeed/dev/jsonl-viewer" or "/Users/mufeed/dev/jsonl/viewer".
- SOLUTION: read the `cwd` field of the first JSONL entry of each
  directory. That `cwd` is the real absolute path.

STREAM-JSON PARSING:
- One line = one JSON object. Use BufReader::lines() (tokio).
- Relevant events:
  {type: "system", subtype: "init", session_id, ...}
  {type: "user", message: { content: [...] }}
  {type: "assistant", message: { content: [{type: "text", text}, {type: "tool_use", id, name, input}, ...] }}
  {type: "user", message: { content: [{type: "tool_result", tool_use_id, content, is_error}] }}
  {type: "result", subtype: "success" | "error", cost_usd, duration_ms, num_turns, ...}
- tool_use and tool_result are nested INSIDE messages, they are not top-level types.

PROCESS KILL:
- tokio::Process::kill() only kills the child, not the group.
- claude spawns subprocesses (Bash, etc.) — they are left as zombies.
- Fix: process-wrap crate with ProcessGroup::leader() on Unix.

TAURI V2 GOTCHAS:
- Events must be declared in capabilities/default.json with permission
  "core:event:default" or more specific.
- invoke handlers must be registered in lib.rs via tauri::generate_handler!
- macOS: if entitlements are missing, the dialog does not open — include
  "com.apple.security.files.user-selected.read-write" if shipping a DMG.
  For dev with `bun tauri dev` it is usually not required.

SOLIDJS GOTCHAS:
- No useState / useEffect — use createSignal, createEffect, createMemo.
- createStore for nested updates (e.g. chat messages).
- Tauri listeners return Promise<UnlistenFn>; cleanup in onCleanup.
- If session_id changes (pending → real), re-subscribe with a createEffect
  depending on the signal.

TAILWIND V4:
- There is no tailwind.config.js. Everything via @import "tailwindcss" in CSS
  + @theme {} for customization.
- Plugin: @tailwindcss/vite in vite.config.ts.
```

---

## Implementation Blueprint

### Data models / types

```typescript
// src/lib/claude-events.ts
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }

export type ClaudeEvent =
  | { type: "system"; subtype: "init"; session_id: string; model: string; cwd: string }
  | { type: "user"; message: { role: "user"; content: string | ContentBlock[] } }
  | { type: "assistant"; message: { role: "assistant"; content: ContentBlock[] } }
  | { type: "result"; subtype: "success" | "error"; session_id: string; cost_usd?: number; duration_ms?: number; num_turns?: number; is_error?: boolean }

export type SessionMeta = {
  id: string                    // Claude Code session_id
  timestamp: string             // ISO of the first message
  first_message_preview: string // truncated to ~100 chars
  project_path: string          // real cwd
}
```

```rust
// src-tauri/src/sessions.rs
#[derive(serde::Serialize, specta::Type, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub timestamp: Option<String>,
    pub first_message_preview: Option<String>,
    pub project_path: String,
}
```

### Tasks (in execution order)

```yaml
Task 1 — Scaffold:
  - RUN (in /tmp): bun create tauri-app claude-desktop-scaffold --template solid-ts --manager bun --yes --identifier com.willywg.claude-desktop
  - MERGE into current repo: move src/, src-tauri/, index.html, package.json, vite.config.ts, tsconfig*.json, .gitignore
  - KEEP existing: PROJECT.md, CLAUDE.md, docs/, PRPs/, .git/
  - EDIT .gitignore: add target/, dist/, node_modules/ if not present
  - INSTALL: bun add -d @tailwindcss/vite tailwindcss
  - INSTALL: bun add @tauri-apps/plugin-dialog
  - INSTALL Rust: cd src-tauri && cargo add tauri-plugin-dialog which process-wrap --features tokio1 dirs anyhow serde_json futures tokio-stream
  - CONFIGURE vite.config.ts: add @tailwindcss/vite plugin
  - CONFIGURE src/index.css: @import "tailwindcss";
  - REGISTER plugin-dialog: in src-tauri/src/lib.rs and tauri.conf.json
  - CAPABILITIES: add dialog:default to capabilities/default.json
  - VERIFY: bun tauri dev opens a window

Task 2 — binary.rs:
  - CREATE: src-tauri/src/binary.rs
  - MIRROR pattern from: ~/proyectos/open-source/claudia/src-tauri/src/claude_binary.rs
  - IMPLEMENT: find_claude_binary() -> Result<PathBuf, String>
    1. `which claude` crate
    2. Fallbacks: $HOME/.claude/local/claude, /usr/local/bin/claude,
       /opt/homebrew/bin/claude, $HOME/.nvm/versions/node/*/bin/claude,
       $HOME/.volta/bin/claude, $HOME/.asdf/shims/claude
    3. Validate: exec `claude --version` with 2s timeout; must succeed
  - EXPOSE as #[tauri::command] get_claude_binary() -> Result<String, String>
  - REGISTER in lib.rs invoke_handler

Task 3 — sessions.rs:
  - CREATE: src-tauri/src/sessions.rs
  - IMPLEMENT:
    - fn claude_projects_dir() -> PathBuf  // ~/.claude/projects via dirs crate
    - fn read_cwd_from_jsonl(path: &Path) -> Option<String>
      → parse the first N lines until finding a message with a `cwd` field
    - fn extract_first_user_message(path: &Path) -> (Option<String>, Option<String>)
      → skip <command-name>, <local-command-stdout>, "Caveat:" prefixes
      → return (content, timestamp)
  - COMMANDS:
    - list_sessions_for_project(project_path: String) -> Vec<SessionMeta>
      → iterate ~/.claude/projects/*/*.jsonl
      → match cwd == canonicalized project_path
      → sort by timestamp desc
    - list_session_entries(session_id: String) -> Vec<serde_json::Value>
      → find the .jsonl by name, return all parsed lines
  - REGISTER both in lib.rs

Task 4 — Project picker (frontend):
  - CREATE: src/components/project-picker.tsx
  - USE: @tauri-apps/plugin-dialog open({ directory: true })
  - STATE in App.tsx: const [projectPath, setProjectPath] = createSignal<string | null>(
      localStorage.getItem("projectPath")
    )
  - EFFECT: createEffect(() => { if (projectPath()) localStorage.setItem("projectPath", projectPath()!) })
  - RENDER: if !projectPath() → <ProjectPicker onPick={setProjectPath} />
            else → main layout (Task 7)

Task 5 — claude.rs (stream-json spawn):
  - CREATE: src-tauri/src/claude.rs
  - STATE: struct ClaudeState { current: Arc<Mutex<Option<CommandChild>>> }
    → managed via app.manage()
  - COMMAND: claude_send(app, project_path, prompt, model, resume_session_id?)
    1. find_claude_binary() via binary.rs
    2. Build args:
       ["-p", &prompt, "--model", &model,
        "--output-format", "stream-json", "--verbose"]
       if let Some(sid) = resume_session_id { args.push("--resume"); args.push(&sid) }
    3. Kill existing current if any
    4. tokio::Command::new(bin).args(args).current_dir(&project_path)
       .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null())
    5. Wrap with process-wrap ProcessGroup::leader() (Unix) / JobObject (Windows)
    6. spawn → take stdout + stderr
    7. Spawn tokio task:
       let session_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
       loop read_line from stdout:
         parse as Value
         if type==system && subtype==init:
            session_id = v["session_id"] → emit "claude:session" { session_id }
         emit "claude:event:{session_id_or_pending}" with the raw line
       on EOF / error → emit "claude:done" { code }
    8. Store child in ClaudeState
  - COMMAND: claude_cancel(app) → kill whatever's in ClaudeState
  - REGISTER in lib.rs

Task 6 — Frontend chat context + components:
  - CREATE: src/context/claude.tsx
    - createStore<{ sessionId: string | null, messages: ChatMessage[], status: "idle" | "running" | "error" }>
    - fn send(prompt, model, resume_session_id?) → invoke("claude_send", ...)
    - listener on "claude:session" → set sessionId
    - listener on "claude:event:pending" AND "claude:event:{sessionId()}" via createEffect
    - process event → append to messages
  - CREATE: src/components/chat-view.tsx
    - <ChatHeader session_id status />
    - For each message: switch on type → <MessageUser /> | <MessageAssistant /> | <ToolCall /> | <ToolResult /> | <ResultSummary />
    - <form onSubmit → ctx.send> with textarea + submit + cancel button
  - CREATE leaf components (plain Tailwind)

Task 7 — Sidebar + layout:
  - EDIT: src/App.tsx
    - Grid: [260px 1fr]
    - Left: <SessionsList projectPath={...} onNew={...} onSelect={...} />
    - Right: <ChatView activeSessionId={...} />
  - CREATE: src/components/sessions-list.tsx
    - createResource(projectPath, (p) => invoke("list_sessions_for_project", { projectPath: p }))
    - "New session" button on top
    - List of SessionMeta with timestamp + preview (line-clamp-2)
    - Click → onSelect(session.id) → parent sets activeSessionId

Task 8 — Validation:
  - RUN the 9 steps from docs/sprint-01-poc.md §"User flow"
  - CREATE: docs/sprint-01-results.md with:
    - Steps passed / failed
    - First-event latency (time from send → first stream-json line)
    - LOC count (rust + ts)
    - Bugs discovered
    - Decisions for Sprint 02
  - COMMIT + tag v0.0.1-poc
```

### Pseudocode — critical pieces

```rust
// src-tauri/src/claude.rs — the heart of it
use std::sync::Arc;
use tokio::{io::{AsyncBufReadExt, BufReader}, process::Command, sync::Mutex};
use std::process::Stdio;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct ClaudeState { pub current: Arc<Mutex<Option<tokio::process::Child>>> }

#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    project_path: String,
    prompt: String,
    model: String,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    // 1. Kill existing
    if let Some(mut old) = state.current.lock().await.take() {
        let _ = old.kill().await;
    }

    // 2. Find binary
    let bin = crate::binary::find_claude_binary().map_err(|e| e.to_string())?;

    // 3. Build args
    let mut args: Vec<String> = vec![
        "-p".into(), prompt,
        "--model".into(), model,
        "--output-format".into(), "stream-json".into(),
        "--verbose".into(),
    ];
    if let Some(id) = resume_session_id {
        args.push("--resume".into()); args.push(id);
    }

    // 4. Spawn (TODO: wrap with process-wrap ProcessGroup::leader() for real kill)
    let mut cmd = Command::new(&bin);
    cmd.args(&args).current_dir(&project_path)
       .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // 5. Reader task
    let app2 = app.clone();
    tokio::spawn(async move {
        let session_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Parse to capture session_id on system/init
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v["type"] == "system" && v["subtype"] == "init" {
                    let mut sid = session_id.lock().await;
                    if sid.is_none() {
                        if let Some(id) = v["session_id"].as_str() {
                            *sid = Some(id.to_string());
                            let _ = app2.emit("claude:session", id);
                        }
                    }
                }
            }
            let channel = match &*session_id.lock().await {
                Some(id) => format!("claude:event:{id}"),
                None => "claude:event:pending".to_string(),
            };
            let _ = app2.emit(&channel, &line);
        }
        let _ = app2.emit("claude:done", ());
    });

    // stderr → just log
    let app3 = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app3.emit("claude:stderr", &line);
        }
    });

    *state.current.lock().await = Some(child);
    Ok(())
}

#[tauri::command]
pub async fn claude_cancel(state: State<'_, ClaudeState>) -> Result<(), String> {
    if let Some(mut child) = state.current.lock().await.take() {
        child.kill().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

```typescript
// src/context/claude.tsx — listener with session-id promotion
import { createContext, createEffect, onCleanup, ParentProps, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { listen, UnlistenFn } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import type { ClaudeEvent } from "@/lib/claude-events"

type ChatMsg =
  | { kind: "user"; text: string }
  | { kind: "assistant"; blocks: any[] }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { kind: "result"; cost_usd?: number; duration_ms?: number; is_error?: boolean }

type Store = {
  sessionId: string | null
  messages: ChatMsg[]
  status: "idle" | "running" | "error"
}

const Ctx = createContext<ReturnType<typeof make>>()
function make() {
  const [store, setStore] = createStore<Store>({ sessionId: null, messages: [], status: "idle" })

  // Session listener
  let unSession: UnlistenFn | undefined
  listen<string>("claude:session", (e) => setStore("sessionId", e.payload))
    .then((u) => (unSession = u))

  // Done listener
  let unDone: UnlistenFn | undefined
  listen("claude:done", () => setStore("status", "idle")).then((u) => (unDone = u))

  // Dynamic event listener (re-subscribes when sessionId changes)
  createEffect(() => {
    const sid = store.sessionId ?? "pending"
    let unEvent: UnlistenFn | undefined
    listen<string>(`claude:event:${sid}`, (e) => {
      const ev = JSON.parse(e.payload) as ClaudeEvent
      applyEvent(setStore, ev)
    }).then((u) => (unEvent = u))
    onCleanup(() => unEvent?.())
  })

  onCleanup(() => {
    unSession?.()
    unDone?.()
  })

  async function send(projectPath: string, prompt: string, model: string, resumeId?: string) {
    // Optimistic user message
    setStore("messages", (m) => [...m, { kind: "user", text: prompt }])
    setStore("status", "running")
    if (!resumeId) setStore("sessionId", null) // reset to listen on "pending"
    try {
      await invoke("claude_send", {
        projectPath, prompt, model, resumeSessionId: resumeId ?? null,
      })
    } catch (err) {
      setStore("status", "error")
      console.error(err)
    }
  }

  async function cancel() { await invoke("claude_cancel"); setStore("status", "idle") }

  return { store, send, cancel }
}

function applyEvent(setStore: any, ev: ClaudeEvent) {
  // Simplified dispatch — flesh out in Task 6
  if (ev.type === "assistant") {
    setStore("messages", (m: ChatMsg[]) => [...m, { kind: "assistant", blocks: ev.message.content }])
    // TODO: extract tool_use blocks into separate entries for cleaner UI
  } else if (ev.type === "result") {
    setStore("messages", (m: ChatMsg[]) => [...m, { kind: "result", cost_usd: ev.cost_usd, duration_ms: ev.duration_ms, is_error: ev.is_error }])
    setStore("status", "idle")
  }
  // Ignore type === "user" (we already added the optimistic one)
}

export function ClaudeProvider(props: ParentProps) {
  return <Ctx.Provider value={make()}>{props.children}</Ctx.Provider>
}
export function useClaude() {
  const v = useContext(Ctx)
  if (!v) throw new Error("useClaude outside ClaudeProvider")
  return v
}
```

### Integration points

```yaml
TAURI_CAPABILITIES (src-tauri/capabilities/default.json):
  - "core:default"
  - "core:event:default"          # listen/emit
  - "dialog:default"              # plugin-dialog
  - custom commands (auto-granted if in invoke_handler)

TAURI_PLUGINS (src-tauri/src/lib.rs):
  .plugin(tauri_plugin_dialog::init())
  .manage(ClaudeState { current: Arc::new(Mutex::new(None)) })
  .invoke_handler(tauri::generate_handler![
      binary::get_claude_binary,
      sessions::list_sessions_for_project,
      sessions::list_session_entries,
      claude::claude_send,
      claude::claude_cancel,
  ])

VITE (vite.config.ts):
  import tailwindcss from "@tailwindcss/vite"
  plugins: [solid(), tailwindcss()]

CSS (src/index.css):
  @import "tailwindcss";
  @theme { /* optional custom tokens */ }
```

---

## Validation Loop

### Level 1: Syntax & style
```bash
# Frontend
bun run typecheck       # tsc --noEmit

# Rust
cd src-tauri && cargo check && cargo clippy -- -D warnings
```

### Level 2: Unit tests
> No formal suite in the PoC. Manual test covers the critical paths.

Optional if time allows:
- Test `extract_first_user_message` with fixtures (sample `.jsonl`).
- Test `find_claude_binary` by mocking PATH.

### Level 3: Manual integration — the 9 steps in `docs/sprint-01-poc.md`

```bash
bun tauri dev
```

1. Window opens → "Open project" screen.
2. Click the button → native dialog → pick `/Users/alice/dev/my-claude-project` (or any project with real sessions).
3. UI switches to a 2-col layout with the sessions listed.
4. Click "New session" → empty chat panel + input.
5. Type "hi, what's in this repo?" + enter.
6. Observe: my message → system/init with session_id → tool_use (Bash/Read/Glob) → assistant streaming → result.
7. Refresh (Cmd+R): same project remembered; new session shows up in the sidebar.
8. Click on that session + send "and how many files?" → Claude replies with context.
9. While a turn is running → click "Cancel" → the process dies (`ps aux | grep claude` shows nothing).

Expected:
- First event (`system/init`) arrives in < 3s.
- No red errors in the devtools console.
- `~/.claude/projects/<encoded>/<new-session-id>.jsonl` created on disk.
- `cargo check` + `bun run typecheck` clean.

---

## Final Checklist

- [ ] Task 1 — Scaffold + Tailwind configured, `bun tauri dev` runs
- [ ] Task 2 — `get_claude_binary` returns a valid path
- [ ] Task 3 — `list_sessions_for_project` returns real, sorted sessions
- [ ] Task 4 — Dialog opens, localStorage persists
- [ ] Task 5 — `claude_send` emits stream-json events; cancel works
- [ ] Task 6 — Chat view renders the 4 message types
- [ ] Task 7 — Full layout with sidebar wiring
- [ ] Task 8 — 9 steps pass; `docs/sprint-01-results.md` written
- [ ] `cargo check` + `cargo clippy -- -D warnings` clean
- [ ] `bun run typecheck` clean
- [ ] Final commit tagged `v0.0.1-poc`

---

## Anti-Patterns to Avoid

- ❌ Use a PTY for the chat — the PoC is specifically about validating piped stream-json
- ❌ ANSI-parse the output — ignore claude's stderr for this sprint
- ❌ Invent a session store in SQLite or JSON — use `~/.claude/projects/` directly
- ❌ Use `--dangerously-skip-permissions` — we want to see real prompts
- ❌ Copy OpenCode's `cli.rs` (it's an HTTP sidecar, wrong pattern)
- ❌ Decode the directory name with `.replace('-', '/')` — it is NOT reversible
- ❌ Attempt concurrent multi-session — one active at a time
- ❌ Add out-of-scope features (model picker, shiki markdown, file tree, diff)

---

## Notes

- **Confidence: 8/10** for one-pass. Claudia validates the pattern 100%; residual risk is the scaffold + Tailwind v4 (minor warnings/config may surface).
- **Estimated time:** 3–5 effective days per the sprint doc.
- **After the PoC**, natural Sprint 02: file tree + file viewer + markdown rendering + model picker. Settings SQLite comes in Sprint 03.
- **Decision on markdown:** in the PoC we render a raw `<pre>`. `marked` + `shiki` come in Sprint 02.
