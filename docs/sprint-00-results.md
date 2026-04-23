# Sprint 01 — PoC Results

> **Date:** 2026-04-16
> **Tested commit:** (fill in when running)
> **`claude` binary:** `/Users/willywg/.local/bin/claude` v2.1.112
> **Platform:** macOS (Darwin 25.3.0)
> **Status:** ⏳ pending manual user validation

## How to run the validation

```bash
bun tauri dev
```

First Rust build takes ~3–5 min cold. After that HMR is instant.

Open **devtools** in the window (Cmd+Option+I) before you start; stream-json events are logged there if anything fails.

## User flow — 9 steps

Check each one off as you go. If something fails, note it under *Bugs*.

- [ ] **1.** The window opens without red warnings in the Tauri/Vite console.
- [ ] **2.** I see the initial screen with the **"Open project…"** button. Click → native dialog → pick a folder with previous sessions (suggestion: `/Users/alice/dev/my-claude-project` with ~5 sessions).
- [ ] **3.** The UI switches to a 2-column layout. The left side shows the project + list of previous sessions with date and preview. The right side shows an empty header + input.
- [ ] **4.** Click **"+ New session"** → the right side is ready, header says `— · idle`.
- [ ] **5.** I type a short prompt (e.g. `hi, list the files in this repo`) and send with ⌘+Enter or by clicking Send.
- [ ] **6.** I observe, in order:
  - My message appears immediately in indigo.
  - Status changes to `running`.
  - Header shows the real session id (8 chars + …).
  - `init` line with `cwd=...` and `model=sonnet` (or whichever arrives).
  - One or more `Bash`/`Read`/`Glob`/etc. cards with their input and then their result.
  - Assistant message with the answer.
  - Final line `done · $0.00xx · Xs`.
  - Status returns to `idle`.
- [ ] **7.** Cmd+R (reload): same project remembered, same session list. The just-created session **shows up at the top** with my prompt as preview.
- [ ] **8.** Click on that session → chat clears. I type `and how many files were they?` → Claude replies with the previous conversation's context (i.e. `--resume <id>` works).
- [ ] **9.** While a turn is running (status=`running`), click **Cancel** → the button disappears and status returns to `idle`. In an external terminal: `ps aux | grep -v grep | grep "claude -p"` shows nothing.

## Metrics to capture

- **First event** (send → `init` or `hook_started` appears in UI): ___ ms
- **First assistant token** (send → first `assistant_text`): ___ s
- **LOC** (fill by running `cloc src src-tauri/src --exclude-dir=target`):
  - Rust: ___
  - TypeScript/TSX: ___
- **Warnings** `cargo clippy -- -D warnings`: ___
- **Warnings** `bun run typecheck`: ___

## Bugs found

> Format: impact, steps to reproduce, stack/log if applicable.

- [ ] (none so far)

## Confirmed decisions

- [ ] Stream-json works as the primary channel inside Tauri v2.
- [ ] `~/.claude/projects/` is parseable without inventing our own storage.
- [ ] `--resume <session_id>` keeps context across turns.
- [ ] `process-wrap` was not needed in the PoC — `kill_on_drop` + `Child::kill()` were enough for a single-child process. Revisit when Claude launches subshells via Bash.

## Known gaps (scope for Sprint 02)

1. **Continued sessions open an empty chat.** `list_session_entries` is implemented but unused on `onSelect`. In Sprint 02, selecting a session should rehydrate events into the timeline.
2. **stderr only goes to the devtools console.** If `claude` fails due to auth or an invalid model, the user doesn't see it in the UI. Add a toast or banner.
3. **Model picker hardcoded (`sonnet`).** Sprint 02 should read available models from somewhere and allow switching.
4. **No markdown rendering.** `assistant_text` is shown as plain text (`whitespace-pre-wrap`). Sprint 02: `marked` + `shiki`.
5. **No syntax highlighting in tool input/result.** JSON pretty-print only.
6. **No visual streaming indicator.** The assistant message appears all at once when the event lands, not token-by-token (a limitation of stream-json which emits complete blocks).
7. **No persistence of the last `activeSessionId`** (only the project). This is intentional — reload starts "clean" to avoid rehydrating something we still don't know how to display well.

## Next sprint (draft)

1. Rehydrate history when opening an existing session (`list_session_entries` → timeline).
2. Markdown + syntax highlighting for assistant text and tool results.
3. Model picker + persistence of the last choice.
4. Toast / banner for `stderr` errors.
5. Start Phase 2 of PROJECT.md: file tree + file viewer.

## Verdict (fill in at the end)

- [ ] **APPROVED** — 9/9 steps, proceed with Sprint 02
- [ ] **APPROVED with changes** — describe the required adjustments
- [ ] **BLOCKED** — describe the problem and plan

Tag `v0.0.1-poc` on approval:

```bash
git tag -a v0.0.1-poc -m "Claude Code-in-Tauri PoC approved"
```
