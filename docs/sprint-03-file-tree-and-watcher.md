# Sprint 03 — File tree + JSONL watcher + Sessions/Files sidebar tabs

> **Status:** in progress (branch `sprint-03-file-tree-and-watcher`)
> **PRP:** [PRPs/004--file-tree-and-jsonl-watcher.md](../PRPs/004--file-tree-and-jsonl-watcher.md)

## Goal in one paragraph

The 280px left panel becomes a two-tab surface: **Sessions** (unchanged behavior) and **Files** (new). The Files tab shows a VS Code / Warp-style tree of the active project, lazy-loaded on expand, reactive to filesystem changes. A collapse button shrinks the whole panel to a 36px rail; clicking the rail (or `⌘B`) re-expands it. In parallel, a background JSONL watcher propagates `/rename` live to tab labels and correlates "new" tabs with their real `sessionId` once Claude writes the first line.

## Three subsystems bundled together

They share fs-reactivity infrastructure, so splitting would duplicate plumbing:

1. **Sidebar tabs + collapse** — UI-only refactor of the existing `<aside>`.
2. **File tree** — `notify-debouncer-full` watcher per project + `ignore` crate for gitignore + lazy Tauri command `list_dir`.
3. **JSONL watcher** — one global `notify-debouncer-full` watcher on `~/.claude/projects/`, emits `session:new` / `session:meta`.

## Non-negotiable decisions

- **Sidebar tabs live inside the existing aside**, not a new column.
- **Collapsed = 36px rail** (not 12px). Shows chevron + Sessions/Files icon shortcuts. Discoverability over minimalism.
- **Global collapsed state, per-project active tab.** Matches Warp / VS Code.
- **File click is select-only.** Right-click → Copy path / Reveal in Finder. No double-click action in v1.
- **Per-project fs watcher, LRU cap 3.** Opening Files for a 4th project evicts the LRU.
- **Single global JSONL watcher.** Installed at app boot via `tauri::Builder::setup`.
- **FIFO correlation with 30s sanity guard** for new-tab ↔ sessionId. FIFO over `spawnedAt`; known edge case (fast typing in a newer tab) documented and accepted.
- **Cmd+B global shortcut** toggles collapsed. Handled at `window` level.

## Out of scope (deferred)

- **Activity panel** (which files Claude is touching via `tool_use`) → PRP 005.
- **Diff viewer, open-in-editor, file preview** → Sprint 04.
- **Hidden-files toggle / show-gitignored toggle** → Sprint 04 or later.
- **Claude Code Channels integration** → PRP 006+ (native permission-prompt relay is interesting but orthogonal).

## Dependencies added

- `notify = "8"`
- `notify-debouncer-full = "0.6"`
- `ignore = "0.4"` (ripgrep's gitignore engine)
- `lru = "0.14"` (watcher eviction policy)

Frontend: no new npm deps — `@tauri-apps/plugin-opener` already gives us `revealItemInDir`.

## Risks addressed in the PRP

1. **JSONL timing unreliable as a correlation signal.** Empirically verified: file birth-time does not match either spawn-time or first-user-input time. Fallback = FIFO queue.
2. **FSEvents flood during `bun install` or similar.** Mitigation: debounce 150ms + gitignore filter at the event level (node_modules/ is filtered before emission).
3. **Per-project watcher cost.** Mitigation: LRU cap 3, measured at design time.
4. **Cmd+B vs xterm.js keystroke capture.** Mitigation: window-level listener; if xterm.js consumes it first, we'll revisit.

## Acceptance (what the user will verify)

The detailed QA checklist lives in `PRPs/004--file-tree-and-jsonl-watcher.md` under "Validation Loop — Level 3". 17 manual steps total, covering sidebar tabs, collapse, file tree, JSONL watcher, and Sprint 02 regression.

## Follow-ups on close

- `docs/sprint-03-results.md` with LOC, surprises, any decision changes.
- Tag `v0.3.0` once merged to main.
- Draft PRP 005 for the activity panel if requested.
