# PRP 023 — Agent registry and agent-scoped session state

**Issue:** [#102](https://github.com/willywg/klaudio-panels/issues/102)
**Status:** in progress
**Scope:** refactor only — Claude stays the only agent, and nothing in the UI
changes

## The problem

Klaudio Panels is a shell around one CLI agent. The ask is for it to host
several — `cursor-agent` first, then plausibly codex, opencode and others —
and for "+ New session" to offer the choice.

This PRP does not add an agent. It makes the session and tab layer
agent-aware *while Claude is still the only one*, so that adding the second
is a row in a table instead of a rewrite.

## What we found

**The PTY layer is already agnostic.** `spawn_pty` takes a binary and argv,
and two of the three `pty_open*` variants already run things that are not
`claude` — the embedded editors and the bottom-panel shell. The only
Claude-specific code in `pty_open` is `find_claude_binary()`, the
`expected_profile_id` check, and the warp env vars.

**What is coupled to Claude is session identity**: where sessions live
(`sessions.rs`), which root is watched (`session_watcher.rs`), how a
brand-new tab is correlated to a session id (the FIFO window in
`session-watcher.tsx`), how a workspace is remembered
(`open-tabs.ts` / `last-session.ts`), and which live events are allowed to
touch a tab (the `profileId === "default"` gates).

**It generalizes.** `cursor-agent` stores each chat at
`~/.cursor/chats/<md5(cwd)>/<chatId>/meta.json` with `cwd`, an optional
`title`, `createdAtMs`, `updatedAtMs` and `hasConversation`, alongside a
`prompt_history.json`. That maps onto `SessionMeta` field for field, and
`cursor-agent --resume <chatId>` exists. This PRP is shaped by that fact but
implements none of it — see PRP 024.

## Non-goals

No `cursor-agent`. No picker. No agent badge. **No observable change of any
kind**, including for a project pinned to a non-default `CLAUDE_CONFIG_DIR`.
If a reviewer can tell this landed by using the app, something is wrong.

`list_agents` is deliberately absent: PRP 024's picker needs it, this one has
no caller for it, and a command with no consumer is a promise nobody has
checked.

## The registry

`src-tauri/src/agent.rs` holds one entry. An agent answers four questions:

1. **Where is my binary?** `binary.rs` today is a five-step candidate walk —
   installer paths first, then `which_in_shell` against the hydrated login
   shell, then `which`, then static fallbacks, then nvm's node versions —
   validated with a 2s `--version` probe. All of that is agent-neutral except
   the two Anthropic installer paths and the binary name, which become part
   of the spec. The "not found" message, with its install hint, moves into the
   spec too; it is the one place in this PRP where a second agent would
   otherwise produce a message telling the user to `npm i -g
   @anthropic-ai/claude-code`.
2. **How do I start?** argv for new, continue, and resume-by-id. A constant
   flag is not enough — resume is `--resume <id>` for both Claude and Cursor
   but there is no reason to assume the third agent agrees — so this is a
   function from a `Launch { New, Continue, Resume(id) }` to a `Vec<String>`.
3. **Where do my sessions live, and how do I list them?** The Claude
   implementation is today's `list_sessions_for_project`: resolve the config
   dir through `project_env` (so a project's direnv still redirects it), then
   scan the encoded project dir.
4. **What do I watch?** Claude answers `<config-dir>/projects`. The
   single-root limitation stands, unchanged and still noted in `CLAUDE.md`.

**Enum dispatch, not `Box<dyn SessionProvider>`.** Two variants do not justify
dynamic dispatch, and the exhaustive `match` is the point: when someone adds a
variant, the compiler lists every question the new agent has failed to answer.
That is the property this whole PRP is buying.

## `agentId` on the tab

`TerminalTab` gains `agentId`, resolved by the caller **before the tab is
created** — the same rule as `profileId`, for the same reason. A tab that
exists for even one tick without knowing which agent it belongs to is a tab a
live event can be misrouted to, and the fix for that is not a later
assignment, it is never having the gap.

`pty_open` takes `agent_id` and resolves the binary through the registry.
`list_sessions_for_project` takes it too.

## Profiles stay a Claude concept

`resolve_profile_id` takes an `agent_id` and matches exhaustively: Claude
derives the profile from direnv's `CLAUDE_CONFIG_DIR` as it does today,
everything else is `"default"`.

**We do not fold the agent into the profile id.** `"claude:default"` as a
single string is tempting — one namespace segment instead of two — and it is
wrong twice over. It silently changes the meaning of every
`profileId === "default"` gate, so the gate change and the stored-key change
land in the same literal and a mistake in one is invisible in the other. And
it conflates two independent axes: *which CLI* and *which account of that
CLI*. Cursor will eventually want the second, and it will not want to spell it
the way Claude does.

## The stored state, and why this must happen now

Today a remembered workspace is `openTabs:<projectPath>:<profileId>`, and
every id in it is assumed resumable with `claude --resume`. The moment a
second agent can create tabs, that assumption is silently false: reopening a
project would try to resume a Cursor chat id under Claude, and the failure
lands on the user as a tab that dies on wake.

**While Claude is the only agent, the migration is unambiguous — every
existing key is Claude's.** After a second agent ships it is a migration
racing new-generation writes. This is the reason PRP 023 and 024 are separate
changes, and it is the only part of this work that cannot be deferred.

The new shape puts the agent first:

```
lastSessionId:<agentId>:<projectPath>:<profileId>
openTabs:<agentId>:<projectPath>:<profileId>
```

Agent-first so a `localStorage` dump groups by agent, and so an old-generation
key is recognizable at a glance: project paths are absolute, so a key whose
first segment after the prefix starts with `/` predates this PRP. We never
rely on that — see below — but a debugging property that costs nothing is
worth having.

### Migrated lazily, per project, with no parsing

There is no key scan and no rewrite pass at boot. When a project is opened we
already know its path, its agent and its profile, so both the new key and the
old one can be *constructed*, never parsed. The read walks a ladder:

1. The agent-namespaced key. Present → use it, done.
2. Claude only: the profile-namespaced key. Present → copy it to the new key,
   remove the old one, use it.
3. Claude with the `"default"` profile only: the pre-profile unnamespaced key.
   Unchanged — `auto-resume.ts` already validates it against the live session
   listing before trusting it, and that behaviour is not touched here.

Three generations, one new rung. `getOpenTabIds` / `setOpenTabIds` and
`getLastSessionId` / `setLastSessionId` grow an `agentId` parameter and the
ladder lives behind them, as a pure function, tested alongside the existing
`last-session.test.ts` and `open-tabs.test.ts`.

Two rejected alternatives, for the record:

- **Scan `localStorage` and rewrite every matching key at boot.** Requires
  parsing a key whose middle segment is a filesystem path that may itself
  contain a colon, to decide which generation it belongs to. The lazy ladder
  never has to answer that question because it starts from the values.
- **Leave Claude's keys implicit — only non-Claude agents get a segment.**
  Free today, and it is precisely the shape that created the legacy
  unnamespaced `lastSessionId:` this codebase is still carrying a migration
  for. It also makes "is this key Claude's, or is it unmigrated?"
  undecidable, which is the same trap one level down.

## Events carry their agent

`session:new`, `session:meta` and `session:complete` gain the agent that
produced them; in this PRP the watcher hardcodes `claude`, because that is
literally what it watches.

The consumers stop inferring. `findPromotionCandidate` and
`shouldApplySessionMeta` in `session-watcher.tsx`, and the tab lookup in
`notifications.tsx`, match the event's agent against the tab's instead of
assuming. Today every comparison is `claude` against `claude` and nothing
changes; that is the point — the gate becomes structural before there is
anything for it to exclude, rather than after.

## Module layout

**Rust**

- `agent.rs` (new) — the spec, the registry, `Launch`, and the session-provider
  enum with its single `Claude` variant.
- `binary.rs` — `find_claude_binary` generalizes to `find_agent_binary(&spec)`.
  The registered `get_claude_binary` command has no caller anywhere in `src/`;
  it goes.
- `pty.rs` — `pty_open` takes `agent_id`, resolves through the registry. The
  profile re-derivation stays, gated on the agent being Claude.
- `sessions.rs` — the scan becomes the Claude provider's implementation;
  `SessionMeta` is unchanged.
- `session_watcher.rs` — asks the registry for Claude's root instead of
  computing it, and tags what it emits.
- `project_env.rs` — `resolve_profile_id` takes `agent_id`.

**Frontend**

- `context/terminal.tsx` — `agentId` on `TerminalTab`, on `OpenTabOpts`, and
  threaded through `openTab` / `restoreTabs` / `wakeTab`. `wakeTab` stops
  hardcoding `["--resume", sessionId]` and asks for the agent's resume argv.
- `components/last-session.ts`, `components/open-tabs.ts` — the key builders
  and the migration ladder.
- `lib/auto-resume.ts`, `lib/restore-tabs.ts` — agent threaded through; the
  legacy rung's semantics untouched.
- `context/session-watcher.tsx`, `context/notifications.tsx` — gates matched
  against the event's agent.
- `App.tsx` — the four `openTab` / `restoreTabs` call sites resolve the agent
  (constant `"claude"` here) next to where they already resolve the profile.

**Docs** — `CLAUDE.md` decisions #1, #5, #9, #10 and #13 rewritten in
agent-neutral terms, naming Claude as the only registered agent rather than as
the architecture.

## What this commits us to

After 024, Klaudio Panels is a shell for CLI agents that ships with Claude,
not a Claude client. That is a product decision as much as a technical one and
it is worth making on purpose. Nothing here forces it — 023 alone is
invisible — but it is the door this opens.

## Acceptance

- Opening a project restores the same workspace as before the upgrade, from
  the pre-migration keys, exactly once; the old key is gone afterwards and the
  new one holds the same value.
- A project on a custom `CLAUDE_CONFIG_DIR` resumes under its own profile and
  never reads the default profile's keys — before or after migration.
- A project whose only pointer is the pre-profile unnamespaced key still
  auto-resumes, and still only for the default profile.
- Live `/rename`, tab-label correlation of a new session, and completion
  notifications all behave exactly as they do today.
- `bun run typecheck`, `bun test`, `cargo clippy -- -D warnings`, `cargo test`
  clean.

**QA note:** the migration only means anything against *existing* stored
state, so it has to be exercised on an upgrade over a real install, not on a
fresh profile where every ladder rung is empty.
