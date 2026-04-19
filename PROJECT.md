# Claude Code UI — Project Blueprint

> Native window that **embeds Claude Code running in a PTY**, with a projects/sessions sidebar and (later) file tree, diff viewer, and free-form terminal.

## Goal

A desktop app built with Tauri v2 + SolidJS that **shows the real Claude Code TUI** inside a window panel, without reimplementing its UI nor parsing its output. The user gets the full CLI for free (slash commands, interactive permissions, `-r` picker, autocomplete, hooks) and the app adds UX around it:

1. **Central terminal with Claude Code** — native `claude` running in a PTY; xterm.js renders bytes as-is.
2. **Projects and sessions sidebar** — folder picker + session list read from `~/.claude/projects/`. Click a session → `claude --resume <id>` in the PTY.
3. **File tree** (Phase 2) — side panel, fast navigation, git status badges.
4. **Diff viewer** (Phase 3) — review panel based on `@pierre/diffs`.
5. **Additional free-form terminal** (Phase 4) — extra tabs for shell/other CLIs.

## Integration Strategy — Pure PTY

**Claude Code runs as an interactive process in a PTY.** The app does not parse its output, it only renders it.

```
┌─────────────────────────────────────────────────┐
│  User types into xterm.js                       │
│       │ bytes                                    │
│       ▼                                          │
│  Tauri invoke("pty_write", id, bytes)           │
│       │                                          │
│       ▼                                          │
│  portable-pty master.write() → PTY slave        │
│       │                                          │
│       ▼                                          │
│  claude CLI (native TUI: colors, cursor, etc.)  │
│       │ stdout/stderr                            │
│       ▼                                          │
│  portable-pty master.read() → emit              │
│  event "pty:data:<id>" with bytes               │
│       │                                          │
│       ▼                                          │
│  xterm.js term.write(bytes) → screen            │
└─────────────────────────────────────────────────┘
```

**Ways to invoke `claude`** (all in a PTY):

| UI action                         | Command                    |
| --------------------------------- | -------------------------- |
| Click "+ New session"             | `claude`                   |
| Click "Continue last"             | `claude -c`                |
| Click a session in the sidebar    | `claude --resume <id>`     |

### Session persistence

**We reuse Claude Code's native storage.** Sessions live in `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`. The app:
- Reads these JSONL files to list sessions in the sidebar (timestamp + first-message preview).
- Writes nothing there. Does not rehydrate messages in the UI — `claude --resume` does that for us inside the PTY.
- For its own settings (active project, window state) it uses `localStorage` and, later, SQLite.

## Tech Stack

| Layer                | Technology                              | Rationale                                                      |
| -------------------- | --------------------------------------- | -------------------------------------------------------------- |
| **Native shell**     | Tauri v2 (Rust)                         | Small binary, auto-update, fast IPC                            |
| **Frontend UI**      | SolidJS 1.9                             | Signals + stores, ergonomic                                    |
| **CSS**              | TailwindCSS v4                          | Utility-first                                                  |
| **Components**       | Kobalte (headless) + custom             | Accessible                                                     |
| **Build**            | Vite 7                                  | HMR                                                            |
| **PTY**              | `portable-pty` (Rust) + `xterm.js` (TS) | Interactive `claude` spawn, full TUI rendering                 |
| **Diff engine**      | `@pierre/diffs` (Phase 3)               | Battle-tested engine from OpenCode                             |
| **Syntax highlight** | Shiki (Phase 2)                         | Lazy grammar loading                                           |
| **Git**              | `git2` (Phase 3)                        | Diff, status, log                                              |
| **File watching**    | `notify` (Phase 2)                      | File tree refresh                                              |
| **App state**        | `localStorage` (PoC) → `rusqlite` (F5)  | Settings, active project                                       |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri v2 Window (Rust)                                      │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  SolidJS App (webview)                                 │ │
│  │  ┌──────────────┐ ┌─────────────────────────────────┐ │ │
│  │  │  Sidebar     │ │  Terminal (xterm.js)            │ │ │
│  │  │              │ │                                 │ │ │
│  │  │ Projects     │ │  ┌─ renders PTY bytes ───────┐ │ │ │
│  │  │ Sessions     │ │  │                            │ │ │ │
│  │  │ (JSONL list) │ │  │   claude > _              │ │ │ │
│  │  │              │ │  │                            │ │ │ │
│  │  │ [+ New]      │ │  └────────────────────────────┘ │ │ │
│  │  └──────────────┘ └─────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Rust Backend (Tauri Commands + Events)                     │
│  ├─ binary.rs   : detect `claude` on PATH                    │
│  ├─ sessions.rs : list sessions from ~/.claude/projects/    │
│  ├─ pty.rs      : portable-pty + shell env hydration        │
│  └─ (later phases)                                           │
│     ├─ fs.rs    : readdir + notify watcher                  │
│     ├─ git.rs   : diff/status via git2                       │
│     └─ config.rs: SQLite settings                            │
└─────────────────────────────────────────────────────────────┘
```

## Layout — Sprint 01 (single-PTY)

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Code UI                            ─ □ ✕          │
├───────────────┬──────────────────────────────────────────────┤
│  Project      │                                              │
│  psicolab     │  $ claude                                    │
│  ← change     │  │ ✻ Claude Code v2.1.112                   │
│               │  │                                            │
│  [+ New]      │  │ Hi! What do you want to do today?         │
│               │  │                                            │
│  SESSIONS     │  │ > _                                       │
│  7:21pm       │                                              │
│  files in…    │                                              │
│               │                                              │
│  5:58pm       │                                              │
│  langsmith    │                                              │
│               │                                              │
│  Apr 2        │                                              │
│  ssh docker   │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

A single active PTY. Switching sessions kills the previous PTY and spawns a new one with `--resume <id>`. Multi-tab arrives in Sprint 02.

## Project Structure

```
cc-ui/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs              # Tauri setup, registers commands
│       ├── binary.rs           # Detect `claude` (reused from Sprint 00)
│       ├── sessions.rs         # Parse ~/.claude/projects (reused from Sprint 00)
│       ├── pty.rs              # portable-pty + shell env
│       └── shell_env.rs        # probe_shell_env / load_shell_env
│
├── src/
│   ├── App.tsx                 # 2-column layout
│   ├── index.tsx               # Entry
│   ├── index.css               # Tailwind
│   │
│   ├── context/
│   │   └── terminal.tsx        # Active PTY: id, write, resize, kill
│   │
│   ├── components/
│   │   ├── project-picker.tsx  # Directory dialog
│   │   ├── sessions-list.tsx   # Sidebar + "+ New session"
│   │   └── terminal-view.tsx   # xterm.js mount + addon-fit + keybinds
│   │
│   └── lib/
│       └── paths.ts            # Path helpers
│
├── package.json
├── vite.config.ts
├── tailwind.config.ts (v4: @import only)
└── tsconfig.json
```

## File Tree, Diff, File Viewer — Later Phases

These components **feed off filesystem + git, not the PTY**. There is no integration between Claude Code and the UI beyond the PTY itself. When Claude edits a file, the `notify` watcher detects it, the file tree refreshes, the diff panel recomputes. The app never "peeks into" the PTY.

This keeps two disciplines separated:
- **What Claude does** → visible in the native TUI.
- **What changes in the repo** → visible via filesystem/git in dedicated panels.

## Ecosystem References

### OpenCode Desktop (anomalyco/opencode) — primary reference

Now it does apply. OpenCode Desktop is the template: a native window with an embedded CLI.

| OpenCode path                                                 | What to learn                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/desktop/src-tauri/src/cli.rs` L220-L365             | `probe_shell_env` + `load_shell_env` + `merge_shell_env` — **critical for nvm/volta/asdf** |
| `packages/app/src/components/terminal.tsx`                    | Terminal integration (they use ghostty-web, we use xterm.js, pattern transfers) |
| `packages/app/src/context/terminal.tsx`                       | Lifecycle, buffer persistence, resize                          |
| `packages/app/src/pages/session/terminal-panel.tsx`           | Tabs (for Sprint 02)                                           |

**What NOT to copy from OpenCode**:
- The sidecar-HTTP pattern in `cli.rs` (above L220) — it assumes the CLI is a server with WebSocket endpoints. `claude` has no server; we spawn the PTY directly.
- `ghostty-web` — it's their own fork, we use xterm.js as the standard.
- `packages/opencode/`, `packages/sdk/`, `packages/shared/` — their LLM server, irrelevant.

### Claudia (getAsterisk/claudia) — archived

Reference for the discarded approach (stream-json wrapper). It served in Sprint 00 to validate the session parser and binary detection. No longer consulted for architecture.

## Implementation Plan — Phases

### Sprint 00 ✅ (archived)
stream-json PoC. Validated binary detection + JSONL parser + scaffold. Discarded as an approach. See `docs/sprint-00-stream-json-exploration.md`.

### Sprint 01 — Claude in PTY (done, 2–4 days)
- [ ] Clean up stream-json code
- [ ] Add `portable-pty` + xterm.js + addons
- [ ] `shell_env.rs` with probe/load/merge of login shell
- [ ] `pty.rs` with `pty_open`, `pty_write`, `pty_resize`, `pty_kill` commands
- [ ] `context/terminal.tsx` + `components/terminal-view.tsx`
- [ ] Wire: sidebar → `pty_open` with appropriate args
- [ ] Validate the 9 steps in `docs/sprint-01-claude-in-pty.md`

### Sprint 02 — Multi-tab + last-session persist (done, 1 week)
- [x] Multi-PTY with tabs
- [x] Visibility-toggle switching (no re-mount)
- [x] `localStorage` last-session per project + auto-resume
- Tag: `v0.2.0`; retro in `docs/sprint-02-results.md`

### Sprint 03a — English translation pass (done, 1 day)
- [x] Full codebase, docs, PRPs, comments translated
- [x] LICENSE / README / CONTRIBUTING added
- Tag: `v0.2.1`

### Sprint 03 — File tree + JSONL watcher + sidebar tabs (in progress)
- [x] Sidebar tabs (Sessions | Files) + collapse rail + Cmd+B
- [x] `fs.rs` with `list_dir` (gitignore-aware) + LRU-3 project watcher
- [x] Lazy file tree with expand/collapse + context menu (Copy path / Reveal in Finder)
- [x] Global JSONL watcher — live `/rename` + new-tab sessionId correlation (FIFO)
- [ ] QA pass on all 17 manual steps from PRP 004
- [ ] Tag: `v0.3.0` when merged

### Sprint 04 — Git + Diff viewer (1-2 weeks)
- [ ] `git.rs` (diff/status/log)
- [ ] Diff viewer with `@pierre/diffs`
- [ ] A/M/D badges in file tree
- [ ] Open-in-editor on double-click

### Sprint 05 — Extra free-form terminal + SQLite settings (1 week)
- [ ] Additional terminal tabs (shell/zsh/arbitrary)
- [ ] `config.rs` with rusqlite
- [ ] Persist favorite projects, layout, theme

### Sprint 06 — Polish & Distribution (1-2 weeks)
- [ ] Theming (dark/light)
- [ ] Configurable keybindings
- [ ] Auto-update with `tauri-plugin-updater`
- [ ] Packaging: dmg / nsis / deb

## Key Dependencies

### Rust (`src-tauri/Cargo.toml`)

```toml
[dependencies]
tauri = { version = "2" }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
portable-pty = "0.8"         # Interactive PTY
which = "7"                  # detect `claude`
dirs = "6"                   # ~/.claude/projects
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
anyhow = "1"
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
```

### TypeScript (`package.json`)

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-opener": "^2",
    "@xterm/xterm": "^5",
    "@xterm/addon-fit": "^0.10",
    "@xterm/addon-web-links": "^0.11",
    "solid-js": "^1.9",
    "tailwindcss": "^4"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4",
    "@tauri-apps/cli": "^2",
    "typescript": "~5.6",
    "vite": "^6",
    "vite-plugin-solid": "^2"
  }
}
```

## Development Commands

```bash
bun install
bun tauri dev        # dev
bun tauri build      # release
bun run typecheck    # tsc --noEmit
cd src-tauri && cargo check
```

## Design Notes

1. **Claude Code is the engine; we embed it, we don't wrap it.** Zero parsing of its output. The real TUI renders as-is in xterm.js.

2. **No parallel structured channel.** No stream-json, no tool_use JSON. If someday we want programmatic hooks (e.g. "when Claude edits, pre-commit"), we do it by watching **the filesystem and git**, not the PTY.

3. **The UI adds visual context, it does not replace functionality.** Sidebar, file tree, and diff viewer are **peripheral** to the terminal. If they all fail, the terminal is still useful.

4. **Shell env hydration is non-negotiable.** Without `probe_shell_env`, tools like `Bash`/`git`/`rg` inside Claude fail silently in macOS GUI apps.

5. **Files + git = source of truth.** There is no conversation database. `~/.claude/projects/` already exists; we read it, we don't duplicate it.
