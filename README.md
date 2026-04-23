# Klaudio Panels

> A native desktop window that **embeds the real [Claude Code](https://claude.com/claude-code) CLI** via PTY, with a Slack-style projects sidebar, multi-tab sessions, and auto-resume.

Built with Tauri v2 + SolidJS + xterm.js. The app is a thin shell around the `claude` CLI — it does **not** reimplement Claude Code's UI, it embeds it. You get every CLI feature for free: slash commands, permission prompts, the `-r` session picker, autocomplete, hooks, colors, mouse tracking.

**Status:** early work-in-progress (v0.2.0). Multi-project + multi-tab + last-session persistence landed in Sprint 02. File tree, JSONL watcher, and diff viewer are the next sprints.

---

## Why

Claude Code's terminal UI is already excellent. What's missing when you run it in Terminal.app is a **shell around it**:

- Multiple projects side by side, one click away.
- Multiple sessions per project, each in its own tab with its own PTY, independent scrollback.
- Auto-resume the last active session when you reopen a project.
- Real session titles (`/rename`) in the sidebar, not just session IDs.
- (Coming soon) a live file tree + diff viewer that shows what Claude is touching, without parsing its output — we watch the filesystem and git instead.

Think of it as a native window around the CLI, not a replacement for it.

## Screenshots

> _TODO: add screenshots once the UI settles._

## Architecture at a glance

```
┌─────────────────────────────────────────────────┐
│  Tauri v2 Window (Rust)                         │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │  SolidJS UI (webview)                     │  │
│  │  ┌────────┬─────────┬──────────────────┐  │  │
│  │  │Projects│Sessions │  xterm.js        │  │  │
│  │  │sidebar │sidebar  │  (renders PTY)   │  │  │
│  │  └────────┴─────────┴──────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  Rust backend                                   │
│  ├─ binary.rs    : detect `claude` on PATH      │
│  ├─ shell_env.rs : hydrate login shell env      │
│  ├─ sessions.rs  : read ~/.claude/projects/*    │
│  └─ pty.rs       : portable-pty spawn + stream  │
└─────────────────────────────────────────────────┘
```

Key rules (see `CLAUDE.md` for the full set):

- **Claude runs interactively in a PTY.** No `-p`, no `--output-format`. xterm.js renders bytes as-is.
- **We never parse the PTY output.** If a feature seems to need it, we watch the filesystem + git instead.
- **Shell env hydration is mandatory.** macOS GUI apps inherit a stripped PATH; we merge the login shell's env so `node`, `nvm`, `git`, `rg` work inside Claude's Bash tool.
- **Sessions live in `~/.claude/projects/`.** We read JSONL files for sidebar previews; we never write there.
- **Each tab is its own PTY.** Switching tabs toggles visibility (never re-creates xterm, to preserve scrollback + WebGL).
- **Persistence is minimal.** `localStorage` for `lastSessionId:<projectPath>`. SQLite is for later.

Full design doc: [`PROJECT.md`](./PROJECT.md).

## Prerequisites

- [Bun](https://bun.com) 1.3+
- [Rust](https://rustup.rs) stable toolchain
- The [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (run `claude` once in a terminal first).
- macOS for now. Linux/Windows should work (Tauri is cross-platform) but haven't been tested this sprint.

## Development

```bash
bun install
bun tauri dev
```

First cold Rust build: ~3–5 minutes. After that HMR is instant.

Other useful commands:

```bash
bun run typecheck               # tsc --noEmit
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

## Building a release

On macOS, build a **universal** binary (native on both Apple Silicon and Intel):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # one-time
bun run release:mac
```

Artifacts land under `src-tauri/target/universal-apple-darwin/release/bundle/`.

Building with a plain `bun tauri build` is fine for local smoke-testing, but **don't ship it** — it produces a host-arch-only binary, which on an x86_64 toolchain means Intel-only, and Apple Silicon users will run it under Rosetta and see macOS's "End of support for Intel-based apps" warning.

On Windows / Linux, `bun tauri build` is still the right command; artifacts land under `src-tauri/target/release/bundle/`.

_Note: we haven't shipped signed release builds yet. Expect a Gatekeeper warning on macOS until code signing + notarization are added (Sprint 05+)._

## Sprint history

| Sprint | Scope                                            | Status       | Tag                          |
| ------ | ------------------------------------------------ | ------------ | ---------------------------- |
| 00     | stream-json PoC — pivoted to PTY                 | ✅ archived  | `v0.0.1-stream-json-poc`     |
| 01     | `claude` in PTY, single tab, sidebar sessions     | ✅ merged    | `v0.1.0-pty`                 |
| 02     | Multi-tab + multi-project + auto-resume + sidebar | ✅ merged    | `v0.2.0`                     |
| 03a    | Full English translation for public readiness    | 🚧 this branch | `v0.2.1` (planned)         |
| 03     | File tree + `notify` watcher + JSONL tailer      | 🔜 planned   | —                            |
| 04     | Diff viewer (`@pierre/diffs`)                    | 🔜 planned   | —                            |
| 05     | SQLite settings, keyboard shortcuts, signed release | 🔜 planned | —                            |

Retros are in [`docs/`](./docs/); PRPs in [`PRPs/`](./PRPs/).

## Troubleshooting

Klaudio Panels writes a diagnostic log on every run. If something goes
wrong, grab it before filing an issue:

**macOS** — `~/Library/Logs/Klaudio Panels/klaudio.log`

```bash
tail -n 200 "$HOME/Library/Logs/Klaudio Panels/klaudio.log"
open "$HOME/Library/Logs/Klaudio Panels"   # reveal in Finder
```

**Linux** — `~/.klaudio-panels/logs/klaudio.log`

```bash
tail -n 200 "$HOME/.klaudio-panels/logs/klaudio.log"
```

Please redact anything you'd rather not share (project paths, usernames,
tokens). The bug report template has a slot for the log chunk.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). In short:

- All repo artifacts (code, comments, docs, PRs, issues, commits) in **English**.
- Open an issue before a large PR so we can agree on scope.
- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`).
- Run `bun run typecheck` + `cargo check` + `cargo clippy -- -D warnings` before pushing.

## Credits

- **[Claude Code](https://claude.com/claude-code)** — the CLI we embed. Without it, there's no app.
- **[OpenCode Desktop](https://github.com/anomalyco/opencode)** — the reference architecture for embedding a CLI in a Tauri native window. We borrowed the `probe_shell_env` / `load_shell_env` / `merge_shell_env` pattern verbatim from their `packages/desktop/src-tauri/src/cli.rs`.
- **[Claudia](https://github.com/getAsterisk/claudia)** — used during the Sprint 00 stream-json PoC for `claude` binary detection and JSONL parsing patterns.

## License

[MIT](./LICENSE) © 2026 William Wong Garay
