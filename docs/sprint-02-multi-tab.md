# Sprint 02 — Multi-tab + last-session persistence

> **Status:** Planning → Ready to execute
> **Branch:** `sprint-02-multi-tab` (created when T1 starts)
> **PRP:** [PRPs/003--multi-tab-and-session-persist.md](../PRPs/003--multi-tab-and-session-persist.md)
> **Base:** `main` (merge commit of `sprint-01-pty`, tag `v0.1.0-pty`)

## Objective

Allow having **multiple Claude Code sessions open simultaneously** in tabs inside the same window, and **auto-resume the last active session** when reopening a project.

## Design decisions (already settled)

1. **Tabs above the terminal** (option A, confirmed by the user). Option B (sidebar indicators) was rejected — tabs are the universal pattern for parallel instances and free up the sidebar.
2. **Single-window** — no multi-window in this sprint.
3. **xterm persistence** = keep N instances mounted, toggle visibility (not `display: none` — it breaks FitAddon/WebGL).
4. **Persistence** = `localStorage["lastSessionId:<projectPath>"]` only. We **do NOT** persist the full list of open tabs. SQLite is Sprint 03/04.
5. **Tab id = PTY UUID**. "New" tabs (no `--resume`) live with `sessionId: null`; correlating them to the JSONL is Sprint 03 work.
6. **Sidebar click semantics** — if a tab is already open for that session → activate that tab. Otherwise → open a new tab. NEVER replace the active tab.
7. **Out of scope:** keyboard shortcuts (Cmd+T/W/1-9), drag-and-drop reorder, tab limits, toast UI, SQLite.

## Tasks (execute in order)

| # | File | What it does |
|---|---|---|
| T1 | `src/context/terminal.tsx` | Refactor to `{ tabs, activeTabId }` + per-id APIs. Per-tab listeners and handler sets. |
| T2 | `src/components/terminal-view.tsx` | Accepts an `id` prop. Does not call `ctx.kill()` in `onCleanup`. Exposes `refit()` for the visibility toggle. |
| T3 | `src/components/tab-strip.tsx` *(new)* | Row of tabs with truncated label + status dot + close × + `+` button. Overflow-x-auto. |
| T4 | `src/App.tsx` | Renders TabStrip + overlay of N `TerminalView` with visibility toggle. `createEffect` to refit on activeTabId change. |
| T5 | `src/App.tsx` + `src/components/last-session.ts` *(new)* | handleNew / handleSelect / handleCloseTab + `lastSessionId` persistence in localStorage. |
| T6 | `src/App.tsx` | `onMount`: if there's a valid `lastSessionId`, auto-resume a tab. Silent fallback if exit code ≠ 0 in <2s. |
| T7 | `src/components/sessions-list.tsx` | `openSessionIds: Set<string>` prop + green dot on sessions that already have a tab. |
| T8 | `CLAUDE.md` + `docs/sprint-02-results.md` | Update rule #9 (single-PTY → multi-PTY tabs). Manual validation + results. |

**The Rust backend is not touched** except for fixes found during integration. `src-tauri/src/pty.rs` already supports N concurrent PTYs.

## Acceptance criteria (12 steps of the golden path)

Detailed in the PRP — *Validation Loop, Level 3* section. Summary:

- [ ] Open 2+ sessions in parallel tabs, independent scrollback.
- [ ] Switching tabs does NOT kill nor restart PTYs.
- [ ] Input in tab A doesn't appear in tab B.
- [ ] Closing the active tab → the previous one is activated.
- [ ] Closing the last tab → placeholder visible.
- [ ] Clicking an already-open session → activates existing tab, doesn't duplicate the PTY.
- [ ] Window resize respects both tabs (refit on activate).
- [ ] Switching project kills all tabs from the previous one.
- [ ] Close+reopen the app → auto-resume only the last active session.
- [ ] `lastSessionId` pointing to a deleted JSONL → no crash, clean fallback.
- [ ] Sprint 01 regression (WebGL, unicode11, Cmd+C/V/K) OK.

Automated validation:

- [ ] `bun run typecheck` clean.
- [ ] `cargo check` + `cargo clippy -- -D warnings` clean.

## Known limitations (document in results)

- **"New" tabs don't correlate with the sidebar** until Sprint 03 adds the JSONL watcher. The label stays as "New session" and no indicator appears in the sidebar for them.
- **No keyboard shortcuts** (Cmd+T/W/1-9) — Sprint 04.
- **No tab reordering** — Sprint 04.
- **We persist only the last active session**, not the full list of tabs — deliberate decision.

## Estimate

2–3 days of work. Main risk: the visibility-toggle + refit pattern when the tab becomes visible again (requires care with FitAddon/WebGL).

## What comes after Sprint 02

**Sprint 03** — basic file tree + `notify` watcher (solves the correlation of "new" tabs with sessionIds discovered in real time).
