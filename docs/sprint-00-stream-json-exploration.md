# Sprint 00 — stream-json exploration (archived)

> **Outcome:** TECHNICALLY APPROVED (the channel works) — DISCARDED as a product approach.
> **Pivot to Sprint 01 "Claude in PTY":** see `sprint-01-claude-in-pty.md`.
> **Git tag:** `v0.0.1-stream-json-poc`.

## Why it was discarded

After seeing the PoC working, the user identified that reimplementing Claude Code's UI gives up key features of the CLI that already exist:

- Slash commands (`/init`, `/help`, `/compact`, etc.)
- Interactive permission prompts
- `-r` session picker and `-c` continue-last
- Path autocomplete
- Hooks (SessionStart, PreToolUse, PostToolUse)
- Interactive planning modes (`ExitPlanMode`)

The correct approach is to **embed the real TUI in a PTY**, like OpenCode Desktop does. Claude Code runs as-is; the app wraps a native window around it.

## What survived from this work

- `src-tauri/src/binary.rs` — detection of the `claude` binary.
- `src-tauri/src/sessions.rs` — parser for `~/.claude/projects/**/*.jsonl` used by the sidebar.
- Full Tauri v2 + SolidJS + Tailwind v4 scaffold.
- `ProjectPicker` + `SessionsList` + 2-column layout.

## Original sprint content (historical reference)

---

# Sprint 01 — PoC: Claude Code inside Tauri

> **Target duration:** 3–5 days of effective work
> **Status:** Planned
> **Single objective:** prove that the primary channel (`claude -p --output-format stream-json`) works inside a real Tauri app, with project selection and listing/continuation of existing sessions.

## Feasibility verdict

**Feasible, high confidence.** Reasons:

- **Claudia does it today** (`getAsterisk/claudia`, Tauri + React + `claude -p stream-json`). Reference code at `~/proyectos/open-source/claudia/src-tauri/src/commands/claude.rs`.
- The user already has **39 projects** with sessions in `~/.claude/projects/` — real data to test against with no setup.
- `claude -p --output-format stream-json` + `--resume <id>` are public, stable flags.

**Concrete risks** (see the section below): (a) the project-directory-name encoding is not reversible — you have to read `cwd` from the JSONL; (b) CLI authentication is out of scope — the app assumes `claude` was already authenticated via the CLI.

---

## PoC scope

### In scope
1. Tauri v2 + SolidJS app that opens a window.
2. **"Open project" dialog** → pick a folder from the system.
3. **List of existing sessions** for that project, read from `~/.claude/projects/`, sorted by date. Each entry shows: timestamp + first user message (truncated).
4. Two actions:
   - **"New session"** → spawn `claude -p ... stream-json --verbose` without `--resume`.
   - **"Continue <session>"** → spawn with `--resume <id>`.
5. **Minimal chat view** that renders stream-json events:
   - `system/init` → capture `session_id` (show in header).
   - `assistant` → markdown text block.
   - `user` → echo the prompt.
   - `tool_use` → compact card with `name` + summarized `input` (no diff viewer yet).
   - `tool_result` → `is_error`, truncated text.
   - `result` → tokens + cost + duration.
6. **Prompt input** → one send per turn. A turn spawns a new `claude -p` process with the latest `session_id` as `--resume`.
7. **Cancel** → button to kill the current process (kill the child).

### Out of scope (explicit)
- ❌ File tree, file viewer, editor
- ❌ Git diff, review panel
- ❌ Free-form PTY terminal (Phase 4)
- ❌ Concurrent multi-session (one active at a time)
- ❌ Settings UI, custom theming, i18n
- ❌ App-level SQLite — the PoC stores the last opened project in `localStorage`
- ❌ Model picker — the default (`sonnet`) is hardcoded
- ❌ Packaging / auto-update — `bun tauri dev` is enough
- ❌ Polished markdown rendering — a `<pre>` with the text is enough to validate

---

## User flow (acceptance)

```
1. Run `bun tauri dev`
2. Window opens → "Open project" screen with a single button
3. Click the button → native dialog → pick /Users/willywg/proyectos/construct-ai/copilot-agent
4. UI switches to a 2-column layout:
   - Left: list of sessions for that project (e.g. 8 sessions with date + preview)
   - Right: empty + "New session" button
5. Click "New session" → right panel shows an empty chat + input
6. Type "hi, what's in this repo?" → enter
7. I see:
   - my message at the top
   - chat header updated with the real session_id
   - tool_use cards (Bash/Read/Glob) appearing in order
   - assistant messages streaming in
   - final `result` event with tokens/cost
8. Refresh the app (Cmd+R) → the same project is remembered → the just-created
   session appears in the list with its first message as preview
9. Click on that session → right panel loads "Continue" → type
   "and how many files does it have now?" → I see that Claude replies with the
   previous conversation's context (proof that --resume works)
```

If the 9 steps work without exceptions, the PoC is approved.

---

## Risks to validate

| # | Risk | How the PoC mitigates it |
|---|--------|--------------------------|
| 1 | **Path encoding** — `/Users/willywg/proyectos` ↔ `-Users-willywg-proyectos` is not reversible if the real path contains dashes. | We don't decode the directory name. We read the **first event of each `.jsonl`**, which contains the `cwd` field with the real path. Matching project ↔ directory is done by comparing `cwd`. |
| 2 | **`claude` binary not found** | `binary.rs` uses the `which` crate + fallbacks (~/.local/bin, /usr/local/bin, nvm shims). If it fails, the UI shows a dialog with a link to `npm i -g @anthropic-ai/claude-code`. |
| 3 | **CLI authentication** — if `claude` is not authenticated, `-p` fails silently or asks for an interactive login. | Out of scope for the PoC. We assume the user has run `claude` at least once. If `-p` returns an error, we show it raw. |
| 4 | **Path encoding for new sessions** — when we spawn `claude` in a new project, does it create the `.jsonl` with the expected encoding? | Validated in step 8 of the user flow: we open the project, create a session, refresh, check that it appears in the list. |
| 5 | **Stream-json buffering** — `tokio::BufReader::lines()` may not deliver lines until the buffer fills up. | Use explicit `read_until('\n')` or `BufReader::lines()` with unbuffered stdout on the `claude` side (stream-json already flushes per line). If lag is perceptible, force `stdbuf -oL` or similar. |
| 6 | **Cancellation leaves a zombie** — killing the Rust process doesn't always kill the `claude` subprocess. | Use `process-wrap` with `ProcessGroup::leader()` on Unix (OpenCode pattern in `cli.rs` lines 471-474). That bit of OpenCode does apply. |
| 7 | **Useless first user message** — sometimes the first `role: user` in the JSONL is an internal system/command (e.g. `<command-name>init`). | Filter: skip if it starts with `<command-name>`, `<local-command-stdout>`, or contains "Caveat: The messages below were generated". Pattern from Claudia's `extract_first_user_message`. |

---

## Tasks (in execution order)

### T1 · Scaffold (30 min)
- `bun create tauri-app claude-desktop --template solid-ts` (in a temp path, then move the contents into this repo without overwriting `PROJECT.md`/`CLAUDE.md`/`docs/`/`PRPs/`)
- Verify `bun tauri dev` opens a window
- Set up TailwindCSS v4 + `@tailwindcss/vite`
- Initial scaffold commit

### T2 · Claude binary detection (1 h)
- `src-tauri/src/binary.rs`
- Simplified port of `~/proyectos/open-source/claudia/src-tauri/src/claude_binary.rs`
- Tauri command: `get_claude_binary() -> Result<String, String>`
- Manual test: returns an absolute path

### T3 · Listing projects and sessions (2–3 h)
- `src-tauri/src/sessions.rs`
- Commands:
  - `list_sessions_for_project(project_path: String) -> Vec<SessionMeta>`
    - `SessionMeta { id, timestamp, first_message_preview }`
    - Iterate `~/.claude/projects/*/`, open the first `.jsonl` of each dir, compare `cwd` against `project_path`, extract sessions
  - `list_session_entries(session_id: String) -> Vec<JsonlEntry>` (for rendering history on continue)
- Reference: Claudia's `list_projects`, `extract_first_user_message` (lines 193–230 of `commands/claude.rs`)

### T4 · "Open project" dialog (30 min)
- Frontend: `@tauri-apps/plugin-dialog` → `open({ directory: true })`
- Store the path in `createSignal` + `localStorage`
- UI: initial screen if no project, main layout otherwise

### T5 · Spawn Claude with stream-json (3–4 h) — **core**
- `src-tauri/src/claude.rs`
- Tauri command: `claude_send(project_path, prompt, model, resume_session_id?) -> Result<(), String>`
- Flags: `-p <prompt> --model <model> --output-format stream-json --verbose [--resume <id>]`
- `tokio::Command` + `Stdio::piped()` + `process-wrap::ProcessGroup::leader()` (Unix)
- `BufReader::new(stdout).lines()` → for each line:
  - Parse JSON
  - If `type == "system" && subtype == "init"` → capture `session_id` in `Arc<Mutex<Option<String>>>`
  - Emit `claude:event:<session_id>` (or `claude:event:pending` if not yet known)
- `claude_cancel()` command → kill the child
- Reference: `spawn_claude_process` lines 1174–1290 in Claudia

### T6 · Frontend chat view (3–4 h)
- `src/context/claude.tsx` — store `{ sessionId, messages, status }`
- `listen<string>('claude:event:...')` listener with re-subscription when session_id is promoted from `pending` to the real one
- Standalone components (no UI library):
  - `<ChatHeader session_id model status />`
  - `<MessageUser text />`
  - `<MessageAssistant blocks />`
  - `<ToolCall name input collapsed />`
  - `<ToolResult text is_error />`
  - `<ResultSummary tokens cost duration />`
- Tailwind only, no Kobalte in the PoC

### T7 · Layout + wiring (2 h)
- `src/App.tsx`: 2 columns (260px sidebar + main)
- Sidebar: session list + "New session" button
- Main: chat or empty state
- Logic: click on session ↔ set `activeSessionId` → when sending a prompt, pass `resume_session_id`

### T8 · Manual validation (1 h)
- Run the 9 user-flow steps
- Write `docs/sprint-01-results.md`: what worked, what failed, metrics (latency of first event, code size in LOC)
- Screenshots / short video

---

## Exit criteria (Definition of Done)

- [ ] `bun tauri dev` opens the app on macOS without warnings
- [ ] The 9 user-flow steps pass in a chain without manual reload
- [ ] Cancelling an active session kills the `claude` process (verified with `ps aux`)
- [ ] Reopening the app remembers the last project (localStorage)
- [ ] `cargo check` and `bun run typecheck` error-free
- [ ] `docs/sprint-01-results.md` written with verdict and next steps
- [ ] Final commit on branch `sprint-01-poc` with tag `v0.0.1-poc`

---

## Open questions / decisions to make

1. **Hardcoded model or picker?** I recommend `sonnet` hardcoded in the PoC; picker can wait for Sprint 2.
2. **Markdown rendering?** Raw `<pre>` is enough to validate. `marked` or `shiki` can come in Sprint 2.
3. **What if the chosen project has no previous sessions?** The list starts empty; only "New session" is shown. No error.
4. **Multiple projects open simultaneously?** No in the PoC. One active project at a time. Switching project kills the running session.
5. **Where do we store `activeProjectPath` across reloads?** `localStorage` (no SQLite yet).

---

## Next sprint (no-scope)

If the PoC passes, a natural Sprint 2:
- File tree + file viewer (Phase 2 of PROJECT.md)
- Markdown rendering with Shiki
- Model picker
- SQLite for app settings
- Unit tests (currently only manual)
