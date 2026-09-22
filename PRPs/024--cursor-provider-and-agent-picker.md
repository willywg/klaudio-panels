# PRP 024 — The Cursor provider, the settings panel, and the picker

**Issue:** [#108](https://github.com/willywg/klaudio-panels/issues/108)
**Status:** draft
**Depends on:** PRP 023 (#102, merged as `951e6f2`) and the `strip_blocked_env`
half of #104 (`9b5cf87`)
**Scope:** the second agent, end to end — registry entry, session provider,
settings panel, Sessions-tab identity, and the `+` picker

## The problem

023 made the session and tab layer agent-aware while Claude was still the
only agent, on the promise that adding the second would be "a row in a table
instead of a rewrite". This PRP is the row, and the bill for that promise.

It adds `cursor-agent` as a first-class agent: discovered, configurable,
spawnable in a PTY, listed in the Sessions tab next to Claude's sessions,
resumable, and offered when the user clicks `+`.

## What we measured

Everything below was read off this machine at `cursor-agent`
**`2026.09.18-9a7762b`**, not inferred from documentation. Where the CLI's
public docs and the shipped bundle disagree in *coverage* — the bundle has
far more — this PRP says which of the two a given behaviour rests on, because
that is the difference between a contract and an implementation detail.

### The three names, confirmed

023 predicted this trap from the docs; it is real, and worse than described.

| Path | What it is |
|---|---|
| `~/.local/bin/cursor-agent` | symlink → `~/.local/share/cursor-agent/versions/<ver>/cursor-agent` |
| `~/.local/bin/agent` | symlink → **the same file** |
| `~/.local/bin/cursor` | a 765-byte POSIX shim that scans `$PATH` for *another* `cursor` and execs it |

The versioned `cursor-agent` is itself a 1.1 KB bash wrapper that execs a
bundled `node` against `index.js`, and its first act is
`export CURSOR_INVOKED_AS="$(basename "$0")"` — so the CLI knows which of its
three names launched it, and so does every child it spawns.

The `cursor` shim only falls through to the agent when there is no Cursor IDE
on `$PATH` **and** `$1` is literally `agent`. On this machine
`/usr/local/bin/cursor` exists, so `cursor` opens the IDE. Spawning it in a
PTY gives you a GUI editor and an empty terminal pane.

**Discovery order:** `cursor-agent`, then `agent` only when a `--version`
probe returns Cursor's date-shaped `YYYY.MM.DD-<sha>`, never `cursor`.

### Where chats live, and the one field that saves us a decode

```
$CURSOR_DATA_DIR/chats/<md5(cwd)>/<chatId>/
├── meta.json           # always
├── prompt_history.json # always
├── pasted_text.json    # sometimes
└── store.db (+ -wal, -shm)   # only once the chat has content
```

`CURSOR_DATA_DIR` defaults to `~/.cursor`. `meta.json`:

```json
{"schemaVersion":1,"createdAtMs":1789928343396,"hasConversation":true,
 "title":"Project Diff Analysis","updatedAtMs":1790094370140,
 "cwd":"/Users/willywg/proyectos/pet-projects/crm-travel"}
```

The directory name is `md5(cwd)` — verified against all 9 directories on this
machine, with zero mismatches. But **we never have to compute it in reverse**,
because `meta.json` carries `cwd` verbatim. That matters more than it looks:
the stored `cwd` is the *resolved* path, so a project opened through a symlink
or under `/tmp` (which macOS resolves to `/private/tmp`) hashes to something
our project path would not produce. Reading `cwd` and comparing it is correct
in every case the hash is correct, and in some it is not.

So: hash the project path to *find* the directory fast, and trust `cwd` to
*confirm* it. Never trust the hash alone.

### `store.db` is opaque, and we are not going to open it

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
```

`meta` holds hex-encoded JSON; `blobs` holds an undocumented binary encoding
of the conversation. Decision #5 says we read an agent's session storage for
sidebar previews and nothing else, and everything the sidebar needs is already
in `meta.json`. Adding a SQLite dependency to reverse-engineer a private blob
format, for a preview string, would be a bad trade twice over — and it would
be reading a live database the agent writes with WAL enabled while it runs.

**`store.db` is out of scope. `meta.json` + `prompt_history.json` is the reader.**

### `prompt_history.json` is newest-first

32 entries in the chat above: `[0]` is `"/exit"` (the last thing typed),
`[-1]` is `"Revisa y dime de que trata este proyecto…"` — the first prompt of
the conversation. So the **last** element is the `first_message_preview`
analogue, and slash commands (`/exit` and friends) must be filtered out
before picking one.

### Empty chats are normal and must not become rows

6 of the 15 chats on this machine have `hasConversation: false` — created,
opened, never used. Claude has no equivalent: a `.jsonl` exists only once
something was written to it. A Cursor session list that shows every directory
would be more than a third noise.

**`hasConversation: false` is not listed**, with one deliberate exception
covered below.

### `create-chat` mints an id and writes nothing

This is the headline finding.

```
$ cd <fresh dir> && cursor-agent create-chat
41a591a0-5a49-407f-bc6b-4c49f5057c27
$ find ~/.cursor -newermt '-3 minutes'
(nothing)
```

The id is real and returned immediately; no directory, no `meta.json`, no
trace on disk anywhere under `~/.cursor`. Documented, too —
"Create a new empty chat and return its ID".

That inverts Klaudio's whole correlation story for this agent, and it is the
reason this PRP is shaped the way it is. See *Correlation* below.

### The environment surface

Documented: `CURSOR_API_KEY`, and `CURSOR_API_ENDPOINT` via `--help`. That is
all. The names below were read out of the shipped bundle — they are **observed,
not contracted**, and this PRP depends on exactly two of them.

| Name | What the bundle does with it |
|---|---|
| `CURSOR_CONFIG_DIR` | config root; falls back to `$XDG_CONFIG_HOME/cursor`, then `~/.cursor` |
| `CURSOR_DATA_DIR` | data root (chats live here); falls back to `~/.cursor` |
| `CURSOR_CONVERSATION_ID` | **read as the fallback conversation id** when none is passed |
| `CURSOR_AGENT_PERSIST_SESSION` | forces the persistent-session path |
| `AGENT_CLI_SOCKET_PATH` | the running CLI's control socket |
| `CURSOR_ASKPASS_SOCKET` / `CURSOR_ASKPASS_SECRET` | the running CLI's askpass channel |
| `CURSOR_INVOKED_AS` | set by the launcher itself, on every run |
| `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | credentials |

## The registry entry

`AgentId::Cursor` and the compiler will then name every unanswered question.

**1. Binary.** `bin_name: "cursor-agent"`. Installer candidates:
`~/.local/bin/cursor-agent`, then `~/.local/share/cursor-agent/versions/*/cursor-agent`.
Fallback `~/.local/bin/agent`, accepted only if its `--version` is
date-shaped. `not_found` points at `curl https://cursor.com/install -fsS | bash`.
Never `cursor`.

**2. `argv`.** `Launch::New` → `["--resume", <id from create-chat>]` (see
*Correlation*); `Launch::Resume(id)` → `["--resume", id]`. `--continue` is
documented as an alias for `--resume=-1` and stays unwired, exactly as
`claude -c` is.

**3. `extra_env`.** Empty. Claude's two entries exist to unlock warp's plugin;
Cursor needs no equivalent, and *this* is where the temptation to set
`CURSOR_CONVERSATION_ID` lives. Don't: it is an undocumented read-fallback,
and `--resume <id>` is the documented path to the same outcome.

**4. `blocked_env`.** The #104 mirror, and the reason this PRP inherits that
fix rather than repeating it. Klaudio launched from inside a `cursor-agent`
session carries that session's markers through the login-shell probe into
every child it spawns. Proposed set, and the one that matters most first:

```
CURSOR_CONVERSATION_ID      # a fresh agent would silently adopt the launching chat
CURSOR_AGENT_PERSIST_SESSION
AGENT_CLI_SOCKET_PATH
CURSOR_ASKPASS_SOCKET
CURSOR_ASKPASS_SECRET
CURSOR_INVOKED_AS
```

Deliberately **not** blocked, and the list is as much about these as about the
ones above:

- `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` — a user may legitimately export
  these; stripping them breaks auth for everyone to protect no one.
- `CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR` — load bearing, the exact analogue of
  `CLAUDE_CONFIG_DIR`. Stripping either moves a project off its own account or
  its own chat store. This is why #104 chose names over a `CURSOR_*` prefix,
  and the reasoning transfers unchanged.

⚠️ **This list is a hypothesis and must be measured before it lands.** #104 was
grounded in a real `ps eww` of a real parent and child, read through
`rtk proxy` after the unproxied tool silently truncated the output. The
equivalent measurement here — launch Klaudio from inside a `cursor-agent`
session, read the app's env and its `cursor-agent` child's env — is an
implementation gate, not a nice-to-have. Names go in the log, never values;
three of the six above are secrets or socket paths.

**5. `list_sessions`.** `cursor_sessions.rs`, new module, mirroring
`sessions.rs`'s role. Walk `$CURSOR_DATA_DIR/chats/<md5(project_path)>/*/`,
read each `meta.json`, drop `hasConversation: false`, confirm `cwd` matches,
and map:

| `SessionMeta` | Cursor source |
|---|---|
| `id` | the `<chatId>` directory name |
| `agent` | `"cursor"` — set by the provider, never inferred (decision #5) |
| `created_at` | `createdAtMs` → RFC 3339 UTC |
| `updated_at` | `updatedAtMs` → RFC 3339 UTC |
| `custom_title` | `title` |
| `summary` | `None` — Cursor's `title` *is* the summary; duplicating it into both fields would render it twice |
| `first_message_preview` | last non-slash-command entry of `prompt_history.json` |
| `project_path` | `cwd` |

**6. `watch_root`.** `$CURSOR_DATA_DIR/chats`. Decision #10's single-watcher
rule is already per-agent via `agent::watch_root`; this is a second root, and
the watcher installs one per registered, enabled agent. A `session:new` fires
on first sighting of a `meta.json`, and `session:meta` on later modification —
the same shape, a different filename.

**7. `supports_profiles`.** `false`, and the reasoning is worth writing down
because it is not "Cursor has no profiles".

Cursor *does* have the concept, but it splits it across two variables where
Claude conflates them into one. `CLAUDE_CONFIG_DIR` answers "which account"
and "where are the sessions" simultaneously, which is why decision #13's
`profile_id` can be derived from a single value. For Cursor, `CURSOR_CONFIG_DIR`
is identity and `CURSOR_DATA_DIR` is storage, and either can move without the
other. A correct Cursor profile id is a function of both, and the watcher would
have to follow `DATA_DIR` while the session list follows the pair.

That is a real feature and it is not this PRP. `supports_profiles → false`
means Cursor is always `"default"` and never pays for a direnv evaluation to
learn it — the behaviour 023 already built for exactly this case. **The cost is
explicit:** a `.envrc` that sets `CURSOR_CONFIG_DIR` will be honoured by the
spawned agent (direnv still applies it to the child env) but ignored by our
session list and our namespacing, so those chats land under the default store
and are listed as one pool. Filed below, not silently absorbed.

## Correlation: Cursor does not need FIFO, and must not use it

Claude's correlation is a guess with a guard: spawn `claude`, wait for a new
`.jsonl` to appear, match it to the oldest un-correlated tab by `spawnedAt`
inside a 30-second window. It exists because `claude` chooses its own session
id and tells nobody.

`create-chat` removes the guess entirely.

**The flow:** the frontend calls a new `agent_create_session(agent_id,
project_path)` command; for Cursor that shells out to `cursor-agent
create-chat` with the project as cwd and returns the id. The tab is created
with that `sessionId` already set — not `null` — and `pty_open` is called with
`Launch::Resume(id)`.

What that buys, beyond elegance:

- No FIFO window, no 30s guard, no race where two quick `+` clicks correlate
  to each other's sessions.
- The tab is in `openTabs` and `lastSessionId` from the moment it exists, so a
  crash before the first prompt still leaves a resumable tab.
- `findPromotionCandidate` is never reached for Cursor — it stays Claude's
  code path, gated by the `agentId` comparison 023 already put there.

And it is the *only* flow that works, because of the measurement above: with
nothing written to disk until the chat has content, a watcher-based
correlation would have no file to see. Bare `cursor-agent` with no id is
therefore **not** a supported launch mode for us.

🔬 **Validation gate.** `--resume <id>` must be confirmed to open a
never-before-used id as an empty chat rather than erroring. If it does not,
the fallback is `create-chat` immediately followed by a throwaway
`--print` invocation to materialize the chat, and that is ugly enough that
it should be re-scoped rather than smuggled in.

## The sessions list becomes a merge

Two providers, one list, sorted by `updated_at` descending, with a per-row
agent glyph. The user's question is "what was I doing in this project", not
"which CLI was I using".

**One provider failing must not blank the other's rows.** This is not free.
`list_sessions_for_project` fails closed on a direnv error today (decision
#13) and that `Err` is correct when Claude is the only agent — it is the
difference between "no sessions" and "we could not tell". In a merge it would
take Cursor's rows down with it. So the command returns per-agent results and
the frontend renders the successes plus an inline, per-agent error row.
Silently dropping a failed provider is the one outcome ruled out: #104 was a
half-day of confusion precisely because a subsystem failed without saying so.

## The settings panel

The app's first real settings surface — every preference today hides in a
titlebar dropdown. Per agent: **enabled** (a toggle) and **binary path** (a
text field).

The binary path is empty by default and shows discovery's answer as
placeholder text, resolved by a `which`-style lookup through the hydrated
login shell (`binary.rs` already does this walk; the panel just needs a
command that runs it and reports the path instead of spawning). Typing a path
overrides it. A configured path that fails its `--version` probe is an error
at save time, not a silent fall-through to a different binary — `binary.rs`
already guarantees that and the panel must surface it rather than swallow it.

`agent_settings.rs` exists and is read at spawn time; 023 deliberately shipped
it without commands because nothing consumed them. This PRP is the consumer:
`list_agents`, `get_agent_settings`, `set_agent_settings`.

## The picker, and when there is none

`+` / New session opens a small agent picker **only when two or more agents are
enabled**. With exactly one, `+` behaves exactly as it does today — no
dropdown holding a single item, no extra click. Nobody running a single agent
pays for this feature.

The same rule governs the Sessions tab glyph: with one agent enabled, a column
that says "claude" on every row is noise.

## Disabling destroys nothing

023 namespaced every stored key by agent id, so a disabled agent's remembered
workspace simply stops being read: its tabs are not restored, its sessions are
not listed, its watcher is not installed. Re-enabling brings all of it back
intact. Disabling never deletes a chat, a key, or a directory.

The last enabled agent cannot be disabled — an app with zero agents is a
window with no purpose and no way back except editing `agents.json` by hand.

## What Claude has and Cursor does not — mapped, not built

Per the scope decision: none of this is implemented in 024. What 024 owes them
is that each one **says what it does when the agent does not support it**,
because degrading in silence is exactly the failure mode #104 cost us.

### 1. Completion notifications (`session:complete`)

Claude gets these from the warp plugin's OSC 777 frames (decision #2's
exception). Cursor has **two** routes to the same signal, and both are real:

- **It already emits OSC 777.** The bundle builds
  `` `${ESC}]777;notify;${title};${message}${ST}` ``, replacing `;` with `,` in
  both fields. That is the *generic desktop-notification* form of OSC 777 — not
  warp's `warp://cli-agent` sentinel with a JSON payload. Our sniffer is
  sentinel-gated and already has a `ignores_wrong_sentinel` test, **so these
  frames are safely ignored today and no collision is introduced by this PRP.**
  Reading them is a future opportunity, not a present hazard.
- **Hooks.** `sessionEnd` and `stop` are documented events, configured from
  `~/.cursor/hooks.json` (user) or `<project>/.cursor/hooks.json` (project).
  `sessionEnd` carries `session_id` (documented as equal to `conversation_id`),
  `reason`, `duration_ms` and `final_status` — richer than the warp frames, and
  it arrives with the id we already hold. The catch is that Cursor's own forum
  carries reports of the CLI not firing every configured event, so this needs
  measurement before it is trusted.

**024's behaviour:** a Cursor tab raises no `needsAttention`, fires no toast
and no OS notification. The notification preferences panel must not offer
per-agent switches it cannot honour.

**→ Issue: "Cursor completion events via hooks or native OSC 777".**

### 2. Per-project accounts (profiles)

Covered above. **024's behaviour:** Cursor is always `"default"`; a `.envrc`
setting `CURSOR_CONFIG_DIR` reaches the spawned agent but not our bookkeeping.

**→ Issue: "Cursor profiles over the CONFIG_DIR / DATA_DIR split".**

### 3. Live `/rename` propagation to tab labels

Claude's watcher sees `custom_title` change in the JSONL and relabels the tab.
Cursor rewrites `meta.json` when its auto-generated `title` changes, so the
same mechanism applies — the watcher work is in scope here, the *labelling*
path needs its own pass.

**024's behaviour:** Cursor tab labels refresh on the Sessions-list refresh
button, not live.

**→ Issue: "Propagate Cursor title changes to open tab labels".**

### 4. Conversation preview beyond the first prompt

Claude's `extract_first_user_message` reads real message content. Cursor's
equivalent lives in `store.db`'s blobs.

**024's behaviour:** preview is `title`, else the oldest non-slash-command
prompt. Good enough, and honest.

**→ Issue: "Richer Cursor previews (requires store.db blob format)" — low priority.**

### 5. Everything that is already agent-neutral

The file tree, git status and history, the diff viewer, the inline editor, the
clipboard history and the bottom-panel shell are project-scoped, not
agent-scoped. They work for a Cursor tab on day one because they never knew
which agent was running. Worth stating so nobody re-derives it.

## Risks

- **Observed-vs-documented.** Two of the six `blocked_env` names and the
  `CURSOR_DATA_DIR` storage root come from reading a shipped bundle. The
  storage layout has been stable across versions and is what every third-party
  Cursor tool reads, but it is not a contract. A layout change breaks the
  Sessions list for Cursor and nothing else — it must not be able to break
  Claude's rows or the spawn path.
- **`create-chat` behaviour is the load-bearing assumption.** The validation
  gate above is not optional.
- **The hash is not the identity.** Resolved paths, symlinked projects and
  `/tmp` vs `/private/tmp` all diverge. Always confirm with `cwd`.
- **Two watchers, two roots.** Decision #11's warning about `notify` costs
  applies: this doubles the global watchers, and `~/.cursor/chats` is a
  shallower tree than `~/.claude/projects` but is written to during an active
  session with WAL files churning. Filter to `meta.json` and ignore
  `store.db*` outright, or the debouncer will fire continuously while an agent
  is thinking.

## Acceptance

1. With both agents enabled, `+` offers a choice; with only Claude enabled,
   `+` behaves exactly as it does today (no picker, no extra click).
2. Choosing Cursor opens a real `cursor-agent` TUI in a tab whose `sessionId`
   is set *before* the first byte arrives.
3. That session appears in the Sessions tab, interleaved with Claude's by
   recency, badged with its agent.
4. Clicking it resumes it. Closing and reopening the project restores it as a
   dormant tab that wakes into the right conversation.
5. Empty Cursor chats (`hasConversation: false`) never appear as rows.
6. A Claude `direnv` failure shows an inline error on Claude's rows and leaves
   Cursor's rows listed.
7. The settings panel shows discovery's path as placeholder, accepts an
   override, and rejects one that fails its `--version` probe.
8. Disabling Cursor hides every trace of it; re-enabling restores the
   workspace unchanged. The last enabled agent cannot be disabled.
9. **The measurement:** Klaudio launched from inside a `cursor-agent` session
   spawns a `cursor-agent` child carrying none of the blocked markers, read
   through `rtk proxy`, names logged and values not.
10. `cargo clippy --all-targets -- -D warnings`, `cargo test`, `bun run
    typecheck` and `bun test` all clean.

## What 025 picks up

The four issues filed above, and the question this PRP deliberately leaves
open: **the third agent.** Codex and opencode are the obvious candidates, and
the honest test of 023's registry is whether adding one is smaller than this
PRP was. If it is not, the abstraction is wrong and 025 is where we find out.
