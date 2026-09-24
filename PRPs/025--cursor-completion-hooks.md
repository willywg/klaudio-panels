# PRP 025 — Cursor completion notifications via hooks

Issue: [#109](https://github.com/willywg/klaudio-panels/issues/109).
Follows PRP 024 (*What Claude has and Cursor does not*, §1).

## Goal

When a `cursor-agent` turn ends in a Klaudio tab, the user gets what a Claude
tab already gets on `session:complete`: the completion chime, a toast (or an OS
banner when the window is blurred), a bell entry, and the tab's amber
needs-attention pulse. The existing preferences apply.

Out of scope: permission / needs-input alerts for Cursor (see *Not solved
here*), #110 (Cursor profiles), #111 (richer previews), a third agent.

## What was measured before writing this

All read from the installed `cursor-agent 2026.09.23-86fc751` bundle
(`~/.local/share/cursor-agent/versions/<ver>/*.index.js`). Line references are
to minified modules, so they're given by module name.

### Route 1: Cursor's own OSC 777 is not usable. Rejected.

`src/notifications/factory.ts` picks a notification backend **by terminal
program**, and every other terminal gets a no-op sender:

| detected terminal | sequence written |
| --- | --- |
| `ghostty`, `warp` | `ESC ]777;notify;Cursor;<message> ST` |
| `iterm2` | `ESC ]9;<message> ST` |
| `kitty`, `vscode` | `ESC ]99;…` (kitty desktop-notification) |
| `apple-terminal` | `BEL` |
| anything else (Klaudio) | nothing |

`detectTerminalProgram` (`src/utils/terminal-environment.ts`) keys on env
markers like `GHOSTTY_RESOURCES_DIR`, `WARP_IS_LOCAL_SHELL_SESSION` and
`ITERM_SESSION_ID`, and then on `TERM_PROGRAM`. Two more gates sit on top:

- The sender is config-gated on `notifications: true` in
  `~/.cursor/cli-config.json`. It is off unless the user turned it on.
- It is focus-gated. The agent enables DECSET 1004 focus reporting and stays
  silent while it believes the terminal is focused.

Making the frames flow would mean impersonating Ghostty or Warp. That also
switches Cursor's image protocol to kitty graphics (the same module maps
`ghostty`, `warp` and `wezterm` to `"kitty"`) and changes its keybinding hints.
It would still depend on a user setting and on focus state. The frames carry
only a human string (`"Cursor is waiting for you"`, `"Approve command: …"`), no
session id. **Do not set `TERM_PROGRAM` or any terminal marker for Cursor.**
`cli_agent.rs` keeps ignoring non-warp frames, as it does today.

### Route 2: The terminal title is not usable. Rejected.

With `display.showStatusIndicators`, Cursor writes `✅ Ready` or
`❓ Waiting for you` into the title (`src/utils/terminal-title-status.ts`).
Reading it means parsing PTY output, which decision #2 forbids. It is also
off by default.

### Route 3: `meta.json` is not usable. Rejected.

`updatedAtMs` is not bumped at the end of a turn. In one measured chat,
`meta.json` was last written at 16:40 while `store.db` kept changing until
16:46.

### Route 4: Hooks. Chosen.

- Event names are in the hooks module (`n = { … }`), which includes
  `stop`, `afterAgentResponse`, `sessionStart` and `sessionEnd`.
- The CLI's hook request handler runs `stop` with:
  - `conversation_id`, which is the chat id our Cursor tab already holds
    (PRP 024: `create-chat` mints it, and the tab resumes it);
  - `generation_id` and `model`;
  - `status`, `loop_count` and token counts;
  - the common fields.

  The same handler has no `sessionEnd` case, so **`stop` is the target**. It is
  also the right one semantically: it fires once per finished turn, and it is
  the same moment the agent's own `onTurnCompleted` uses to send
  `"Cursor is waiting for you"`.
- Config sources come from the hook loader (class `B` in `190.index.js`).
  Every path is fixed, and **no env var or flag adds another**:
  - `/Library/Application Support/Cursor/hooks.json` (enterprise)
  - `<project>/.cursor/managed/active-team-hooks/hooks.json` (team)
  - `~/.cursor/hooks.json` (user)
  - `<project>/.cursor/hooks.json` (project)
  - **Claude's** `~/.claude/settings.json`, `<project>/.claude/settings.json`
    and `settings.local.json`, translated (`Stop → stop`, `SessionEnd →
    sessionEnd`, `Notification` and `PermissionRequest → null`)
  - plugin hooks
- A config path that contains a symlink is refused. The file is parsed as
  JSONC, with `//` and `/* */` comments stripped.
- Hook commands get the payload as JSON on stdin.

What the bundle **cannot** tell us, and step 0 must measure:

1. Whether the CLI actually fires `stop` in an interactive TUI session. Cursor's
   forum reports CLI hooks that never fire.
2. Whether the hook process inherits `cursor-agent`'s environment, meaning our
   `KLAUDIO_*` vars. Routing depends on it.
3. Whether a user-level hook needs a trust or approval step the first time.
4. The exact stdin payload (field names, `status` values), and how a missing
   hook command or a non-zero exit is handled. It must fail open: the agent
   must not stall and must not print an error into the TUI on every turn.

## Design

```
cursor-agent turn ends
  └─ runs hook: <data-dir>/klaudio-panels/bin/klaudio-cursor-hook   (stdin: stop JSON)
       ├─ $KLAUDIO_HOOK_SOCK unset or not a socket → print {} , exit 0   (every non-Klaudio terminal)
       └─ else: send "$KLAUDIO_PTY_ID\n" + stdin to the socket (nc -U, 1 s cap), print {} , exit 0
Klaudio (agent_hooks.rs) accepts on its per-install socket
  └─ pty id → PtySession → (project_path, agent == cursor, expected session id)
       └─ emit "session:complete" { agent: "cursor", project_path, session_id: conversation_id,
                                    stop_reason: status, preview: null }
frontend: existing handleComplete path, with the title made agent-aware
```

### Routing is by PTY id, with the conversation id as a cross-check

`pty.rs` already builds per-child env, and `pbcopy`'s `KLAUDIO_CLIP_SOCK` is
the precedent. For **Cursor children only**, add two vars:

- `KLAUDIO_HOOK_SOCK`, this install's hook socket path;
- `KLAUDIO_PTY_ID`, the frontend-generated PTY id.

The listener resolves the id against the live `PtyState.sessions`. It drops
the event when any of these holds:

- the id is unknown;
- the session is not a Cursor session;
- the payload's `conversation_id` is not the tab's session id.

The last check is the decision #13 / #102 invariant, where an event names its
agent and the tab confirms it. The emitted event is the existing
`session:complete` with `agent: "cursor"`. `resolveCompleteTabId` already
matches on agent + project + session id + `profileId === "default"`, and a
Cursor tab is always `"default"` (PRP 024 §2). **No new frontend routing.**

If step 0 finds the hook does **not** inherit the agent's env, fall back to
routing by `conversation_id` alone. Klaudio knows every open Cursor tab's
session id, so it can map the id to its project path in Rust. Mention the
fallback in the PR. Do not guess a project from `workspace_roots`.

`KLAUDIO_PTY_ID` and `KLAUDIO_HOOK_SOCK` must not reach a *Claude* child. They
are simply not added there, and they are not added to shell or editor PTYs
either.

### Socket: its own, per install, same rules as the clipboard's

Mirror `clipboard_history.rs`:

- one socket per install (`install_key()` / `short_hash`), e.g.
  `~/Library/Caches/klaudio-panels/hook-<hash>.sock`;
- bind synchronously at boot, and run the accept loop on a thread;
- one short-lived thread per connection;
- refuse to steal a live socket (#96), and when another instance owns it,
  withhold `KLAUDIO_HOOK_SOCK`, exactly like `shim_active()`.

Factor the shared socket helpers out of `clipboard_history.rs` rather than
copying them, and keep the clipboard's behaviour and tests unchanged.

The listener reads at most **64 KB** per connection and parses only
`conversation_id`, `status` and `hook_event_name`. Everything else in the
payload is dropped unread. Neither the payload nor any id is logged; logs carry
counts and reasons ("hook event dropped: unknown pty"). The payload may contain
the user's email or prompt-derived fields.

### The hook script: stable path, inert outside Klaudio

- Put it in `dirs::data_dir()/klaudio-panels/bin/klaudio-cursor-hook`, which is
  Application Support and **not** Caches: macOS may purge Caches, and a
  `hooks.json` pointing at a missing file would break every Cursor turn in
  every terminal.
- Rewrite it at every boot, like the `pbcopy` shim. It is shared by every
  install, and each install is told apart by its own `KLAUDIO_HOOK_SOCK`.
- It is `#!/bin/sh`. It always prints `{}` and exits 0, including when `nc` is
  missing, the socket is gone, or the send fails.
- It never waits more than about 1 s (`nc -U -w 1`).
- It never writes the payload to disk, no temp file, the same rule as the
  clipboard shim.
- Outside a Klaudio PTY it must be a no-op that costs about one `test`. The
  user's `cursor-agent` in iTerm or Ghostty runs it too.

### Installing the hook: explicit, reversible, surgical

The only workable config location is the user's `~/.cursor/hooks.json`:

- **enterprise**: needs root;
- **project**: would write into the user's repos;
- **Claude's settings**: would make *Claude* run it too;
- **env var or flag**: none exists.

That file is user configuration, so:

- **Opt-in.** Add a toggle under Cursor in the Agents dialog, e.g. *Turn
  notifications: adds a hook to ~/.cursor/hooks.json*. Off by default, like
  every non-Claude agent capability.
- **Install:**
  - Read the file. If it is missing, create `{"version": 1, "hooks": {}}`.
  - Merge one entry `{"command": "<absolute script path>"}` into
    `hooks.stop`, with no duplicate when it is already there.
  - Preserve every other key and entry.
  - Write atomically: a temp file in the same dir, then `rename`. Keep the
    file mode.
  - Before the first modification, write a one-time backup,
    `hooks.json.klaudio-backup`.
- **Refuse, never clobber:**
  - when the file contains comments, since we would drop them on
    re-serialize;
  - when it does not parse;
  - when `~/.cursor/hooks.json` or `~/.cursor` is a symlink, since Cursor
    itself refuses those.

  Show the snippet for the user to add by hand instead.
- **Uninstall:** remove only entries whose `command` equals our script path.
  Leave `stop: []` in place if that is what remains; do not delete the file.
- **Status** comes from the file, never from a stored flag. The toggle reads
  `hooks.json` on dialog open and shows *on*, *off* or *can't manage
  (edited by hand)*, so a user who removes the entry by hand is not told it is
  still on.
- New Tauri commands go in `agent_commands.rs`: `cursor_hook_status`,
  `cursor_hook_install` and `cursor_hook_uninstall`. All the file logic lives
  in a pure module that takes the `hooks.json` path as a parameter, so tests
  never touch the real `~/.cursor`.
- Uninstalling or disabling Cursor does **not** remove the hook silently. The
  script is inert outside Klaudio, so leaving it is harmless, and deleting
  config the user may have reviewed is not our call. Say so next to the toggle.

### Frontend

- `handleComplete` title: `Claude is done` becomes
  `<agent display name> is done`, with the name from `context/agents.tsx`.
- Body: Cursor sends no preview (`preview: null`), so it falls through to the
  existing "Your turn — open Klaudio Panels."
- `notification-bell.tsx`: the completion switch stays global. The permission
  switch stays Claude/warp-only, and its copy must not imply Cursor coverage
  (PRP 024: *must not offer per-agent switches it cannot honour*).
- Agents dialog: the toggle, its three states, and an inline error with the
  manual snippet when install is refused.

## Not solved here

- **Permission / needs-input alerts for Cursor.** The hook translation maps
  Claude's `Notification` and `PermissionRequest` to `null`. No hook event
  fires when Cursor waits for approval, and `beforeShellExecution` fires for
  every command, approved or not. Leave it unsupported and keep saying so
  (update PRP 024's §1 status in CLAUDE.md or the PR description, not by adding
  a switch).
- A dedup window. The agent only sends a turn-completion notice when its queue
  is empty, but `stop` may fire per turn even with queued follow-ups. If step 0
  shows several `stop`s for one visible turn, coalesce per tab within about
  2 s in Rust. Otherwise add nothing.

## Steps

0. **Measure, in isolation, and record the results in the PR.**
   - Create a scratch project dir under `$TMPDIR` containing
     `.cursor/hooks.json`. The project-level config needs no write to
     `~/.cursor`.
   - Set a `stop` hook that runs `env > $TMPDIR/…/env.txt; cat > $TMPDIR/…/payload.json; echo {}`.
   - Run `cursor-agent` in that dir, not inside Klaudio, with a marker var
     exported (`KLAUDIO_PROBE=1`). Use the interactive TUI when you can drive
     it. If you can't, use a one-shot headless run with a trivial prompt, and
     **say which mode you measured**: the TUI is what Klaudio runs, so the user
     re-checks it in QA.
   - Answer the four questions under Route 4. Also note: does a project hook
     need trust; how many `stop` events one turn with a tool call produces;
     what a missing command path does to the TUI.
   - **If `stop` does not fire in the CLI, stop here and report.** Don't
     switch to `afterAgentResponse` without saying so; it may fire more than
     once per turn.
   - Delete the scratch dir.
1. Factor the socket helpers out of `clipboard_history.rs`, with tests still
   green.
2. `agent_hooks.rs`:
   - the socket, the accept loop, and parse and route to `session:complete`;
   - unit tests for the parser (well-formed, oversize, garbage, missing
     fields) and for the routing decision as a pure function (unknown pty,
     non-Cursor pty, mismatched conversation id, a match).
3. `pty.rs`: add the two env vars for Cursor children only, and a test that a
   Claude spawn never gets them.
4. The hook script, with tests in the `PBCOPY_SHIM` style:
   - it always ends `{}` and `exit 0`;
   - no `mktemp`;
   - it has the `-S` socket check;
   - a shell test runs it with no env and asserts stdout `{}` and exit 0.
5. `hooks.json` management module, pure, with its path injected. Tests:
   - create when missing;
   - merge into an existing `stop` array without dropping entries;
   - idempotent install;
   - uninstall removes only ours;
   - refuse on comments, on invalid JSON and on a symlink;
   - backup written once;
   - atomic write leaves no temp file behind.
6. Tauri commands and the Agents dialog toggle.
7. Make the frontend title agent-aware, with `bun test` coverage for the title
   helper.
8. Docs:
   - CLAUDE.md: a new `agent_hooks.rs` bullet under Module boundaries; one
     sentence under decision #10 saying Cursor now has `session:complete` from
     hooks, not from the watcher.
   - CHANGELOG `[Unreleased]`.
   - Tick the §1 line in PRP 024's follow-up list.

## Acceptance

1. With the toggle on, a Cursor turn finishing in a **background** tab:
   - plays the completion chime;
   - pulses that tab amber when the project has more than one tab;
   - adds a bell entry.

   With the window blurred, it also shows an OS banner. The title reads
   "<project> · Cursor is done".
2. The same turn in the tab the user is looking at: a toast, no pulse. This is
   the existing `shouldRaisePulse` behaviour.
3. `cursor-agent` in iTerm, Ghostty or Terminal with the hook installed shows
   no error, no delay the user can feel, and no output from our script.
4. Two Cursor tabs in one project: only the tab whose turn ended is flagged.
5. A dev build and the installed app running at once each alert only for their
   own tabs, and neither steals the other's socket.
6. Toggle off: the entry is gone from `hooks.json` and every other entry is
   untouched. Toggle on with a commented `hooks.json`: refused, with the manual
   snippet, and the file byte-identical afterwards.
7. The user removes our entry by hand, then reopens the dialog: it shows *off*.
8. Claude tabs behave exactly as before, with the warp route untouched.
9. `cargo clippy --all-targets -- -D warnings`, `cargo test`,
   `bun run typecheck` and `bun test` are all clean.

## Isolation rules for whoever implements this

- **Never launch Klaudio** (debug, release or a copy). App state is keyed on
  the bundle identifier, so any instance restores the user's real workspace
  and resumes their real sessions. Full-app QA is done by the user from steps
  written in the PR.
- **Never write to the real `~/.claude`, `~/.cursor`**, including
  `~/.cursor/hooks.json`, or to `~/Library/Logs/Klaudio Panels/`. Every file
  path in the new code is injectable, and tests use temp dirs. Step 0 uses a
  project-level `hooks.json` under `$TMPDIR`, not the user file. The chat
  that `cursor-agent` itself records under `~/.cursor/chats` during step 0 is
  fine. The rule is about files *you* write.
- Never kill a process you did not start in this task.
- Step 0's `cursor-agent` run happens in a plain terminal in a scratch dir, not
  inside a Klaudio tab, and not in this repo.
