# PRP: [Feature Name]

> **Version:** 1.0
> **Created:** [YYYY-MM-DD]
> **Status:** Draft | Ready | In Progress | Completed
> **Phase:** [1–6 from PROJECT.md, if applicable]

---

## Goal
[End state in one paragraph. Be concrete: what the user can do, what the UI shows, what events fire. Avoid implementation verbs.]

## Why
- [User-visible value — what becomes possible that wasn't before]
- [Unlocks which later phase / which other feature]
- [Tradeoff or constraint this addresses]

## What
[User-visible behavior + technical requirements. One layer deeper than Goal.]

### Success Criteria
- [ ] [Observable outcome 1 — testable by hand or automation]
- [ ] [Observable outcome 2]
- [ ] [Observable outcome 3]

---

## All Needed Context

### Project-level references (always relevant)
```yaml
- file: PROJECT.md
  why: Blueprint, settled architectural decisions, phase plan
- file: CLAUDE.md
  why: Non-negotiable architectural rules (do NOT re-propose rejected options)
```

### Feature-specific documentation & references
```yaml
# Local reference repos (cloned read-only)
- file: ~/proyectos/open-source/claudia/src-tauri/src/commands/claude.rs
  why: [Specific pattern — e.g. "spawn_claude_process emits per-session events"]
  lines: [e.g. 1174-1290]

- file: ~/proyectos/open-source/opencode/packages/ui/src/components/session-review.tsx
  why: [Specific pattern — e.g. "diff accordion with lazy render"]

# External docs
- url: https://docs.anthropic.com/en/docs/claude-code/...
  why: [Specific section, e.g. stream-json schema]
  critical: [Single-line gotcha that saves hours]

- url: https://v2.tauri.app/...
  why: [Plugin API, IPC pattern]
```

### Current repo state
```bash
# Pre-scaffold until Phase 1 runs `bun create tauri-app`.
# Once scaffolded, run: eza --tree --level=2 --git-ignore
```

### Desired changes (files to add/modify)
```bash
# New files with one-line responsibility each
src-tauri/src/
├── claude.rs           # stream-json spawn + per-session emission
└── ...

src/
├── context/claude.tsx  # event listener + chat store
└── components/chat/
    ├── chat-view.tsx
    └── tool-call.tsx
```

### Known gotchas & project rules
```
CRITICAL — from CLAUDE.md:
- Chat channel is piped subprocess + JSON-line parsing. NOT a PTY.
- First `system`/`init` event carries session_id. Isolate all subsequent
  events per session (`claude:event:<session-id>`).
- Sessions persist in ~/.claude/projects/<encoded-path>/<id>.jsonl.
  Don't invent a custom store for conversation history.
- File state comes from filesystem + git. No custom index.
- `packages/desktop/src-tauri/src/cli.rs` in OpenCode is NOT a PTY
  spawner — it's a sidecar-over-pipes pattern. Don't cite it.

LIBRARY QUIRKS:
- portable-pty: master/slave naming; resize requires PtyPair.master
- git2 (libgit2): diff_index_to_workdir for unstaged; include untracked
  requires DiffOptions::include_untracked + recurse_untracked_dirs
- notify: debounce events; Windows emits per-subdir watches
- SolidJS: signals, not React state. `createEffect` for side effects;
  `createResource` for async. Stores for deep updates.
- Tauri v2: `invoke` for request/response; `emit`/`listen` for streams.
  Events must be registered in `capabilities/default.json`.
- @pierre/diffs: expects FileContents { before, after } not unified text
```

---

## Implementation Blueprint

### Data models / types
```typescript
// src/lib/claude-events.ts — align with stream-json schema
export type ClaudeEvent =
  | { type: "system"; subtype: "init"; session_id: string; /* ... */ }
  | { type: "assistant"; message: { content: Array<...> } }
  | { type: "user"; message: { content: Array<...> } }
  | { type: "result"; subtype: "success" | "error"; /* cost, duration */ }
  // tool_use nested inside assistant.message.content blocks

export type ChatStore = {
  sessionId: string | null
  messages: Array<ChatMessage>
  status: "idle" | "running" | "cancelled" | "error"
}
```

```rust
// src-tauri/src/claude.rs
#[derive(serde::Serialize, Clone)]
struct EmittedEvent { session_id: String, line: String }
```

### Tasks (in execution order)
```yaml
Task 1: [Rust command]
  - CREATE: src-tauri/src/{module}.rs
  - MIRROR pattern from: ~/proyectos/open-source/claudia/src-tauri/src/commands/claude.rs
  - ADAPT: remove SQLite registry if this feature doesn't need it
  - REGISTER: in src-tauri/src/lib.rs (add to invoke_handler)
  - CAPABILITY: add command name to src-tauri/capabilities/default.json

Task 2: [Frontend context]
  - CREATE: src/context/{name}.tsx
  - PATTERN: createContext + Provider + useXxx hook
  - LISTEN: use @tauri-apps/api event listen/UnlistenFn; cleanup in onCleanup
  - STORE: createStore for nested updates, signals for flat values

Task 3: [UI component]
  - CREATE: src/components/{area}/{name}.tsx
  - STYLE: TailwindCSS v4 classes only (no CSS-in-JS)
  - A11Y: use Kobalte primitives if interactive

Task N: [Wiring]
  - MODIFY: src/entry.tsx or layout to mount new component/context
```

### Pseudocode (with CRITICAL details)
```rust
// Rust side — stream-json emitter
#[tauri::command]
async fn claude_send(app: AppHandle, prompt: String, model: String,
                     session_id: Option<String>) -> Result<(), String> {
    let bin = find_claude_binary(&app)?;       // which crate + fallbacks
    let mut cmd = Command::new(bin);
    cmd.args(["-p", &prompt, "--model", &model,
              "--output-format", "stream-json", "--verbose"]);
    if let Some(id) = &session_id { cmd.args(["--resume", id]); }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.current_dir(&project_path);            // CRITICAL: cwd = project

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    // CRITICAL: read line-by-line. stream-json emits one JSON object per line.
    // session_id captured from first `system`/`init` event, then used as
    // event channel: `claude:event:<session_id>`. Until captured, buffer or
    // emit on a provisional channel — don't drop events.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut sid: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            if sid.is_none() {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v["type"] == "system" && v["subtype"] == "init" {
                        sid = v["session_id"].as_str().map(String::from);
                    }
                }
            }
            let channel = match &sid {
                Some(id) => format!("claude:event:{id}"),
                None => "claude:event:pending".into(),
            };
            let _ = app.emit(&channel, line);
        }
    });
    Ok(())
}
```

```typescript
// Frontend — context listener
const [store, setStore] = createStore<ChatStore>({ sessionId: null, messages: [], status: "idle" })

createEffect(() => {
  const sid = store.sessionId ?? "pending"
  const unlisten = listen<string>(`claude:event:${sid}`, (e) => {
    const ev = JSON.parse(e.payload) as ClaudeEvent
    // CRITICAL: handle session_id promotion from "pending" → real id
    if (ev.type === "system" && ev.subtype === "init") {
      setStore("sessionId", ev.session_id)
      return  // re-subscribes via effect
    }
    applyEvent(setStore, ev)
  })
  onCleanup(() => { unlisten.then(fn => fn()) })
})
```

### Integration points
```yaml
TAURI_CAPABILITIES:
  - file: src-tauri/capabilities/default.json
  - add: "core:event:allow-listen" for `claude:event:*`
  - add: command permission for new invoke handler

TAURI_REGISTRATION:
  - file: src-tauri/src/lib.rs
  - add to: .invoke_handler(tauri::generate_handler![..., new_command])

CONTEXT_WIRING:
  - file: src/entry.tsx
  - wrap: app tree with new Provider (order matters if contexts depend)

CONFIG_SQLITE (only for app settings, never chat data):
  - table/column: define migration in src-tauri/src/config.rs
```

---

## Validation Loop

> **Pre-scaffold**: none of these commands work until `bun create tauri-app claude-desktop --template solid-ts` has been run. Use this section as the template of what validation WILL look like.

### Level 1: Syntax & style (fast feedback)
```bash
# Frontend
bun run typecheck        # tsc -b
bun run lint             # oxlint or eslint (pick once, see Phase 1)

# Rust
cargo -C src-tauri check
cargo -C src-tauri fmt --check
cargo -C src-tauri clippy -- -D warnings
```

### Level 2: Unit tests
```bash
# Frontend (Vitest or Bun test — pick once)
bun test src/**/*.test.ts

# Rust
cargo -C src-tauri test
```

Test cases to create for this feature:
- [Happy path — describe input/expected output]
- [Error case — what should fail and how]
- [Edge case — empty input, very large input, unicode, etc.]

### Level 3: Integration / manual
```bash
# Run the app
bun tauri dev

# Steps:
# 1. [What to click/type]
# 2. [What to observe in UI]
# 3. [What to verify in devtools Network/console or filesystem/git]
```

Expected:
- [Concrete observable outcome]
- [No red in Tauri devtools console]
- [`~/.claude/projects/...` contains new `.jsonl` if session was created]

---

## Final Checklist

- [ ] Frontend typecheck passes
- [ ] Rust `cargo check` + clippy clean
- [ ] Unit tests added and passing
- [ ] Manual integration flow verified in `bun tauri dev`
- [ ] Tauri capabilities updated if new commands/events added
- [ ] No regression in adjacent features (e.g. adding chat doesn't break terminal)
- [ ] PROJECT.md / CLAUDE.md updated if a decision changed

---

## Anti-Patterns to Avoid

- ❌ Don't spawn `claude` in a PTY for the chat channel (piped stdio only)
- ❌ Don't ANSI/TUI-parse Claude Code output (stream-json is the contract)
- ❌ Don't write conversation history to SQLite (it's in `~/.claude/projects/`)
- ❌ Don't copy OpenCode's `cli.rs` or `terminal.tsx` spawn/connect logic
- ❌ Don't use React idioms in SolidJS (no `useEffect`, no `useState`)
- ❌ Don't hold Tauri async state across `.await` without `Arc<Mutex<...>>`
- ❌ Don't emit per-session events before capturing `session_id` and dropping them
- ❌ Don't forget to register invoke handlers in both `lib.rs` AND capabilities JSON

---

## Notes

[Decisions made during generation, deferred work, follow-up PRPs, etc.]
