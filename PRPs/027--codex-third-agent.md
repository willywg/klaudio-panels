# PRP 027 — Codex as the third registered agent

**Issue:** [#122](https://github.com/willywg/klaudio-panels/issues/122).
**Status:** implemented on `feat/codex-agent-integration`, based directly on
`upstream/main` v1.14.0 (`10357b7`), verified, and prepared for upstream
review.
**Depends on:** PRP 023 (agent registry) and PRP 024 (Cursor as the second
agent).
**Scope:** Codex only: discovery, settings/picker registration, PTY launch,
resume, session listing, live session correlation, environment isolation,
and tests.

## Scope guard

This branch was rebuilt from the last upstream release instead of rebasing
the combined preview branch. It deliberately excludes every preview-only
feature that happened to be present where the first implementation was
developed:

- split terminal groups / multi-panel layout;
- webview zoom hotkeys;
- the profile-aware bottom status bar and its sidecar;
- unrelated image-resolver test cleanup.

The v1.14.0 base does not contain the bottom usage bar. Consequently this PR
does not introduce that entire feature as a hidden prerequisite merely to
show Codex usage. A later status-bar PR can add the Codex rollout adapter on
top of its own clean base.

## The problem

Klaudio v1.14.0 registers Claude Code and Cursor. Codex needs to participate
in the same provider-neutral paths without teaching the picker, tab store,
or Sessions list a new special case. The registry must describe how to find
and validate `codex`, launch and resume it, isolate a nested process from the
outer Codex session, and find its conversations on disk.

## Measured Codex behavior

The integration was measured against real installed binaries, initially
`codex-cli 0.146.0` and re-checked against `0.160.0` on 2026-10-03.

- `codex --version` prints `codex-cli <semver>`.
- Resume is a subcommand: `codex resume <session-id>`, not a `--resume`
  flag.
- Codex cannot mint a resumable id before launch. A new tab therefore uses
  the same watcher/FIFO correlation shape as Claude.
- The standalone installer exposes `~/.local/bin/codex`; npm installations
  may live under the same Bun, Volta, asdf, or nvm locations already searched
  for Claude.
- Sessions live under
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. This pass reads the
  default `~/.codex/sessions` root; project-specific `CODEX_HOME` support is
  deferred.
- Modern resumed rollouts have different `payload.id` values but share one
  stable `payload.session_id`. The latter is what `codex resume` accepts and
  what the Sessions list must collapse by. Older rollouts observed through
  `0.140.0-alpha.2` may omit `session_id`; for those only, `payload.id` is the
  resumable fallback.
- The first user-role item is commonly the synthetic
  `<environment_context>` block. It is excluded from the conversation
  preview.
- Live environment measurements found five outer-session markers that a
  fresh child must not inherit: `CODEX_CI`, `CODEX_PERMISSION_PROFILE`,
  `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_SESSION_ID`, and
  `CODEX_THREAD_ID`. Formatting variables and the informational
  `CODEX_VERSION` remain inherited.

## Registry entry (`src-tauri/src/agent.rs`)

| Function | Codex behavior | Lines |
|---|---|---|
| `spec` | `Codex`, binary `codex`, provider-specific install hint | 88-102 |
| `installer_candidates` | `~/.local/bin/codex` | 109-125 |
| `fallback_candidates` | system paths plus Bun/Volta/asdf/nvm npm locations | 132-187 |
| `accepts_version` | first non-empty line starts with `codex-cli ` | 193-215 |
| `mints_session_ids` | `false` | 241-250 |
| `create_session_argv` | `None` | 256-262 |
| `argv` | new: `[]`; resume: `["resume", id]` | 264-288 |
| `extra_env` | none | 291-314 |
| `blocked_env` | the five measured live-session variables above | 342-403 |
| `enabled_by_default` | `false` | 431-437 |
| `supports_profiles` | `false` | 444-467 |
| `list_sessions` | `codex_sessions::list_codex_sessions` | 469-475 |
| `watch_root` | `~/.codex/sessions` | 481-488 |

`AgentId::Codex` is part of `AgentId::ALL`, so the existing settings dialog,
picker, badges, storage namespaces, merged session list, and restore paths
pick it up without per-component branches.

## Session provider (`src-tauri/src/codex_sessions.rs`)

The provider is separate because Codex partitions storage by date rather
than by project.

- `list_rollout_files` walks generically below the sessions root instead of
  assuming exactly three date directories.
- `read_session_meta_line` reads only the first line and requires a
  `session_meta` record with `cwd`. It prefers `payload.session_id` and falls
  back to legacy `payload.id`.
- `first_real_user_message` scans at most 200 lines and skips the synthetic
  environment context.
- `scan_sessions_root` filters by canonical project path, collapses resumed
  rollout files by stable session id, keeps the newest mtime, and returns the
  same newest-first ordering contract as the other providers.
- `session_from_rollout` is shared with the live watcher so list and event
  mapping cannot drift.

Tests cover field mapping, legacy ids, synthetic prompt exclusion, resumed
rollout collapsing, project filtering/order, and malformed first lines.

## Live watcher and first-session behavior

Codex cannot know its session id before its first rollout exists, so its
watcher emits `session:new` on first sight and `session:meta` thereafter.
`CODEX_SEEN` is independent of Claude's seen set and is seeded when the
watcher starts.

At application boot, Klaudio watches an existing `~/.codex/sessions` but
does not create Codex state for users who have never run it. Immediately
before the first enabled Codex spawn, `pty.rs` calls
`ensure_codex_watcher(..., true)`. That creates the root if necessary and
installs the watcher exactly once. Failure aborts the spawn with an explicit
error because launching without a watcher would leave the new tab
uncorrelated and non-resumable.

## Frontend propagation

`src/lib/agents.ts` adds `CODEX`, includes it in `AGENT_IDS`, and provides
the display metadata used by the existing generic UI. Existing tests were
extended where their fixtures enumerate agents:

- `last-session.test.ts` no longer uses `codex` as an unknown id;
- `merge-sessions.test.ts` verifies three-provider merging;
- `restore-tabs.test.ts` verifies Codex isolation and restore;
- `notifications.test.ts` and `session-watcher.test.ts` verify that events
  are routed by agent as well as session id.

No picker, settings-dialog, sessions-list, tab-store, or storage-key code is
special-cased for Codex.

## Deferred work

1. **Bottom usage UI.** It belongs to the separate status-bar feature, which
   is intentionally outside this PR. Codex rollout `token_count` and
   `turn_context` records can populate that provider-neutral model later.
2. **Completion notifications.** Codex does not yet emit
   `session:complete`, so it does not raise `needsAttention` or a completion
   toast. Its notification mechanism must be measured before integration.
3. **Profiles.** `CODEX_HOME` controls both configuration and session
   storage, but `project_env.rs` currently resolves profiles specifically for
   Claude. Generalizing that is a separate change.
4. **Shell integration.** Whether Codex needs the Cursor-specific login-zsh
   clipboard shim behavior remains unmeasured.

## Verification on the clean v1.14.0 branch

- `cargo test --lib`: 193 passed, 0 failed (run outside the restricted
  sandbox so the existing Unix-socket tests can bind).
- `cargo clippy --all-targets -- -D warnings`: clean.
- `bun run typecheck`: clean.
- `bun run build`: clean.
- Codex-related frontend suites, including notification and watcher routing,
  pass in isolated Bun processes. The all-files `bun test` command still
  reproduces v1.14.0's global `mock.module("@tauri-apps/api/core")` leak from
  `image-files.test.ts`; fixing that unrelated harness issue is deliberately
  excluded by the scope guard above.

## Acceptance

1. With all three providers enabled, the New Session picker offers Claude,
   Cursor, and Codex.
2. Selecting Codex opens the real interactive `codex` TUI in the project
   directory.
3. A first-ever Codex session is correlated even when the sessions root did
   not exist at application boot.
4. Codex sessions appear in the merged Sessions list with the Codex badge and
   a real user prompt preview.
5. Resuming invokes `codex resume <stable-session-id>`.
6. Multiple rollout files for one resumed conversation produce one row;
   legacy rollout ids remain resumable.
7. A nested Codex does not inherit the outer session's identity or sandbox
   policy markers.
8. Existing Claude and Cursor behavior and tests remain unchanged.
9. Rust tests/clippy, frontend typecheck/build, and the Codex-related
   frontend tests are clean.

## Production-build note

Use the Tauri CLI for release builds (`bun run tauri build`), not a bare
`cargo build --release`. The Tauri CLI enables the `custom-protocol` feature
that embeds `dist/`; a raw Cargo release remains wired to the development
URL and can open a blank window when Vite is not running.
