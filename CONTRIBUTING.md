# Contributing

Thanks for your interest in Klaudio Panels. This project is an early-stage personal project that aims to be a useful native shell around the Claude Code CLI. Contributions are welcome, with a few ground rules.

## Before you start

**Open an issue first** if you plan a non-trivial change (more than ~20 lines, any new dependency, any UX change). It saves everyone time if we agree on scope before code is written.

For bugs and small fixes, a PR directly is fine.

## Language

All repo artifacts are in **English**: code, comments, commit messages, PR titles, PR descriptions, issues, PRPs, sprint docs, READMEs. This is a hard rule — it's what makes the project approachable for contributors who don't speak Spanish (the maintainer's first language).

You're welcome to discuss in any language in an issue thread, but merged artifacts stay English.

## Development setup

Prerequisites:

- [Bun](https://bun.com) 1.3+
- [Rust](https://rustup.rs) stable
- The [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (run `claude` once in a terminal, finish the auth flow, then you can use it from the app).
- macOS is the primary target; Linux/Windows should work but aren't routinely tested.

Clone and run:

```bash
git clone https://github.com/willywg/klaudio-panels.git
cd klaudio-panels
bun install
bun tauri dev
```

First cold Rust build takes ~3–5 minutes.

## Branches

- `main` — always releasable. Only merge-commits from sprint branches land here.
- `sprint-NN-<slug>` — one branch per sprint. Regular commits go here until the sprint is validated and merged.
- `fix/<short-name>`, `feat/<short-name>` — for standalone fixes/features outside a sprint.

## Commit convention

Conventional commits, short and lowercase:

- `feat: add live JSONL watcher for session-id discovery`
- `fix(pty): race between Rust emit and JS listen for pty:data`
- `docs: update CLAUDE.md rule #9 for multi-tab`
- `refactor(terminal): extract per-tab handler registration`
- `chore: bump xterm to 6.1.0`

Longer commit bodies are welcome when the *why* isn't obvious from the diff. Reference issues with `Closes #NN` when applicable.

The maintainer's commits include a `Co-Authored-By: Claude Opus 4.x` trailer when an LLM agent substantially authored the change. Not required from external contributors.

## Using AI tools (Claude Code and similar)

PRs authored or co-authored with [Claude Code](https://claude.com/claude-code) or similar agents are welcome — this project is literally a shell around Claude Code and the maintainer uses it daily. A few notes:

- Include a `Co-Authored-By: Claude <trailer>` in commits when the agent did substantial authoring. Not required, but appreciated for transparency.
- For non-trivial changes, consider drafting a **PRP** (Product Requirement Prompt) first. PRPs live in `PRPs/` and are how we plan sprints in this repo — see existing ones for style and structure.
- If you want tooling help writing PRPs, the maintainer publishes a Claude Code skill for it:

  ```bash
  npx skills add https://github.com/willywg/prp-manager --skill prp-manager
  ```

  More info: <https://skills.sh/willywg/prp-manager/prp-manager>
- Whatever tool you use, **you are responsible for the code**. Read the diff, run typecheck + clippy, smoke-test in `bun tauri dev`. An LLM is an author, not a reviewer — that part is still on you.

## Code style

**TypeScript / SolidJS:**

- `createSignal` for scalars, `createStore` for nested state.
- `createEffect(on(signal, fn))` for reactive effects with explicit dependencies.
- Cleanup in `onCleanup`; never leave dangling listeners.
- Tailwind v4 utility classes; no CSS-in-JS.
- No emojis in code unless the task is specifically about emoji rendering.
- Write comments only when the *why* is non-obvious. Don't narrate the *what*.

**Rust:**

- Keep modules small and single-purpose (`binary.rs`, `shell_env.rs`, `pty.rs`, `sessions.rs`).
- Prefer `Result<T, String>` at the Tauri command boundary; serialization errors are less confusing that way.
- `tokio::task::spawn_blocking` for blocking I/O on `portable-pty`, never block the async runtime.
- `cargo clippy -- -D warnings` must pass.

## Validation before pushing

Run all three of these. Every commit must pass:

```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

For UI changes, run `bun tauri dev` and exercise the feature end-to-end before opening a PR.

## Architectural guardrails

Some decisions are settled and not worth re-litigating. Read [`CLAUDE.md`](./CLAUDE.md) §"Non-negotiable architectural decisions" before proposing a redesign. In particular:

- We **don't parse PTY output**. Ever. Features that seem to need that are solved by watching filesystem + git.
- Sessions live in `~/.claude/projects/` (read-only). We don't duplicate conversation history.
- xterm.js instances are never destroyed on tab switch (scrollback + WebGL lose state).
- The JS side owns the PTY UUID (fixes a race with initial-byte emission).

A PR that violates one of these will get a request for a design discussion in an issue before it's reviewed.

## Reviewing PRs

Pipe for review:

1. Green CI (typecheck + cargo check + clippy).
2. One human reviewer approves (currently: the maintainer).
3. Squash merge into `main` with a clean conventional-commit title.

## Questions

File an issue with the `question` label, or reach out via the email in `README.md`.
