# PRP 012: OSC 777 CLI agent events (notifications phase 2)

> **Version:** 1.0
> **Created:** 2026-04-29
> **Status:** Draft
> **Tracks:** [#23](https://github.com/willywg/klaudio-panels/issues/23)
> **Builds on:** [#22 / PR #24](https://github.com/willywg/klaudio-panels/pull/24) (notifications phase 1)

---

## Goal

Catch the two Claude Code events that the JSONL transcript watcher
cannot see — `permission_request` (Claude wants to run a tool that
needs user approval) and `idle_prompt` (Claude has been waiting on the
user) — by adopting the warp `claude-code-warp` plugin's wire format
verbatim, without forking it.

The user installs warp's official plugin once, and Klaudio Panels
picks up the same OSC 777 events warp.app does. Phase 1 (chime, amber
ring, dock badge for `stop`) keeps working with zero plugin required.

## Why

- Phase 1 covers turn-completion via JSONL, which is canonical and
  zero-config but blind to events that never touch disk:
  `PermissionRequest` and `idle_prompt`.
- Warp open-sourced the wire format
  ([`app/src/terminal/cli_agent_sessions/event/{mod.rs,v1.rs}`](https://github.com/warpdotdev/warp))
  in late April 2026. The format is a stable JSON-over-OSC 777 contract
  with `agent: "claude"`, `event: <kind>`, `cwd`, `session_id`, and
  per-event payload.
- The original [#23](https://github.com/willywg/klaudio-panels/issues/23)
  plan was to fork `claude-code-warp` into our own repo with a private
  OSC identifier (`klaudio-panels` instead of `notify`). Two reasons we
  drop that:
  1. Maintenance debt — every plugin update from warp would need to be
     mirrored.
  2. Pointless namespace isolation — each terminal owns its own PTY,
     so warp.app and Klaudio Panels can never consume the same OSC.
     The shared sentinel `warp://cli-agent` is sufficient.

## What

A passive OSC 777 sniffer in the PTY forwarder. Bytes flow to xterm.js
unchanged (xterm.js silently drops unknown OSC numbers, verified). The
sniffer parses framed events in parallel and emits Tauri events to the
frontend, where the existing `NotificationsContext` adds two handlers.

### Success Criteria

- [ ] With the warp plugin installed, when Claude requests permission
      (e.g., `Bash(rm something)`), Klaudio Panels surfaces a native
      notification with the tool name + command preview, plays a more
      attention-grabbing sound (`pulse-c.wav`), and pulses the project
      avatar in the sidebar (amber ring).
- [ ] Same flow for `idle_prompt` ("Claude is waiting for you").
- [ ] Without the plugin, Phase 1 behavior is unchanged: chime + amber
      ring on `stop` via JSONL.
- [ ] When the user is focused on a tab that belongs to the originating
      project, no native notification fires (suppression rule from
      Phase 1 carries over).
- [ ] The PTY byte stream is byte-identical to today's render — the
      sniffer is observe-only. xterm.js sees the same input.
- [ ] No double-emission for `stop` — Rust filters `stop` server-side
      so JSONL stays the only source.
- [ ] OSC frames spanning multiple PTY reads (4KB chunks) parse
      correctly. Both BEL (`\x07`) and ST (`\x1b\\`) terminators work.

### Non-goals

- Codex / Gemini / OpenCode support. Their plugins emit the same wire
  format, but Klaudio embeds `claude` only — track separately if/when
  the embedding generalizes.
- Action buttons on the permission notification (Allow / Deny). v1
  is notification + click = focus window. Inline buttons need
  `UNUserNotificationCenter` (gated on [#25](https://github.com/willywg/klaudio-panels/issues/25)).
- Replacing JSONL with OSC. JSONL is canonical for `stop`, lossless,
  zero-config, and also drives tab→sessionId correlation and `/rename`
  refresh — which OSC does not.

## How

### Wire format (verbatim from warp)

Frame: `\x1b]777;notify;<TITLE>;<BODY>\x07` (also accepts `\x1b\\` ST).
Sentinel `<TITLE>`: `warp://cli-agent`. `<BODY>` is plain JSON:

```json
{
  "v": 1,
  "agent": "claude",
  "event": "permission_request",
  "session_id": "...",
  "cwd": "/abs/path/sometimes/subdir",
  "project": "/abs/path/of/project",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf /tmp/foo" },
  "plugin_version": "2.0.0"
}
```

Other fields (`query`, `response`, `transcript_path`, `summary`) are
populated for other events and ignored for our two.

### Backend — `src-tauri/src/cli_agent.rs` (new)

Stateful sniffer per PTY, owned by the forwarder task:

```rust
pub struct Osc777Sniffer { state: SnifferState, body: Vec<u8> }
enum SnifferState {
    Normal,
    Matching { matched: usize },  // matched first N bytes of prefix
    Capturing,                     // collecting until terminator
    EscInBody,                     // saw \x1b inside body, awaiting \\ for ST
}
const PREFIX: &[u8] = b"\x1b]777;notify;";
const MAX_BODY: usize = 64 * 1024;
const SENTINEL: &str = "warp://cli-agent";
```

`feed(&mut self, chunk: &[u8]) -> Vec<CliAgentEvent>` — does not
consume `chunk`; the caller still forwards it to xterm.js.

Rust-side filter drops two event types before returning, so the
frontend never has to know about them:

- `stop` — JSONL watcher is the canonical source for turn-completion.
- `idle_prompt` — Claude fires this every 60s while the prompt sits
  empty, *including while the user is reading transcript output*.
  In practice this is noise; the actually-blocked case is already
  covered by `permission_request`. Dropped post-v1.5.0 after live
  feedback that the toast was firing while the user was reading
  Claude's diff output.

`tool_input_preview` extraction mirrors warp's logic
([`v1.rs:29-34`](https://github.com/warpdotdev/warp/blob/main/app/src/terminal/cli_agent_sessions/event/v1.rs#L29-L34)):
`tool_input.command || tool_input.file_path` → string.

### Plugin handshake — env vars on Claude spawn

The warp plugin gates structured OSC emission on `should-use-structured.sh`:
both `WARP_CLI_AGENT_PROTOCOL_VERSION` (advertises the highest protocol
version we understand) AND `WARP_CLIENT_VERSION` must be set, and the
client-version string must not match any of the broken warp releases
(channels `*stable*` / `*preview*` / `*dev*` with versions ≤ a hard-coded
threshold). Without both, the plugin fires its **legacy fallback** which
emits a `SessionStart` system message ("Warp plugin installed but you're
not running in Warp terminal — install warp.dev …") and never produces
OSC 777 frames.

We set both env vars in `pty_open` only (not `pty_open_editor` or
`pty_open_shell` — the plugin only runs as a Claude hook):

```rust
("WARP_CLI_AGENT_PROTOCOL_VERSION".into(), "1".into()),
("WARP_CLIENT_VERSION".into(), format!("klaudio-panels-{}", env!("CARGO_PKG_VERSION"))),
```

Our `WARP_CLIENT_VERSION` value (e.g. `klaudio-panels-1.4.1`) doesn't
contain `dev`/`stable`/`preview` substrings, so the channel-specific
threshold is never matched and the gate passes unconditionally.

### Backend — `src-tauri/src/pty.rs`

In the existing forwarder task (`tokio::spawn(async move { while let Some(chunk) = rx.recv() ... })`):

```rust
let mut sniffer = cli_agent::Osc777Sniffer::new();
while let Some(chunk) = rx.recv().await {
    for event in sniffer.feed(&chunk) {
        let _ = app_data.emit("claude:event", &event);
    }
    let b64 = STANDARD.encode(&chunk);
    let _ = app_data.emit(&format!("pty:data:{id_data}"), b64);
}
```

`claude:event` is global (one channel for all PTYs). The payload
itself carries `cwd` and `session_id` so the frontend can route.

### Frontend — `src/context/notifications.tsx`

Subscribe to `claude:event`, branch on `event_type`:

- `permission_request` → title `"Claude needs permission"`, body
  `<tool_name>: <tool_input_preview>` (or just `<tool_name>` if no
  preview), sound `playPermissionRequest()` (new), pulse project,
  same active-project + focused-window suppression as Phase 1.
- `idle_prompt` → title `"Claude is waiting for you"`, body
  `query`, sound `playTaskComplete()` (existing), pulse project,
  same suppression.

`isActiveProject` resolver in `App.tsx` is updated from exact equality
to **path prefix match** (Claude can run in a subdir of the open
project). Order: `payload.project` first, then `payload.cwd`. Match
against the current `activeProjectPath()` with normalized trailing
slashes.

### Frontend — `src/lib/sound.ts`

Add `playPermissionRequest()` using a new asset:
`src/assets/sounds/permission-request.wav` ← copied verbatim from
opencode's `pulse-c.wav`. Same volume / preload pattern as
`playTaskComplete()`.

### CLAUDE.md carve-out

Append to non-negotiable #2:

> **Exception — OSC 777 CLI-agent sidechannel (Sprint 04+):**
> `\x1b]777;notify;warp://cli-agent;<json>\x07` is a stable, public
> wire contract (warp's open-source CLI agent protocol). The sniffer
> in `src-tauri/src/cli_agent.rs` may inspect this sequence to surface
> structured events to the frontend. It does **not** mutate the byte
> stream — xterm.js still receives the original input. This is
> strictly weaker than the original prohibition: we observe a stable
> sidechannel, we don't parse semantic terminal output.

### README — new "Notifications" section

Two tiers:

1. **Built-in (zero-config)** — chime + amber ring + Dock badge fire
   when Claude finishes a turn (driven by the JSONL watcher).
2. **Optional plugin (richer events)** — install warp's plugin to
   also catch `permission_request` and `idle_prompt`:

```bash
claude plugin marketplace add warpdotdev/claude-code-warp
claude plugin install warp@claude-code-warp
```

Note that the plugin scripts depend on `jq` (warp's own install docs
say so). Mention compatibility: same plugin works for warp.app and
the other CLI agents that ship warp plugins (Codex / Gemini /
OpenCode), but Klaudio Panels currently routes only the `claude`
agent.

### Tests

Unit (`cli_agent.rs`):
- Single-chunk happy path: `permission_request` framed in BEL parses.
- Single-chunk happy path: `idle_prompt` framed in ST (`\x1b\\`) parses.
- Split prefix across chunks: `\x1b` in chunk A, `]777;notify;` in B.
- Split title across chunks.
- Split body across chunks.
- Body > 64KB → buffer is reset, no panic.
- `event: "stop"` is dropped (returns no events).
- Bad JSON in body → no event, no panic.
- Wrong sentinel (e.g. `klaudio-panels;`) → ignored, no event.
- `tool_input.command` and `tool_input.file_path` both round-trip into
  `tool_input_preview`.

Manual smoke (post-build):
- Install warp plugin in `~/.claude`.
- Open a Claude session; ask Claude to run `Bash(echo hi)` (which
  prompts for permission). Confirm notification.
- Switch to another project tab (focused but different project) and
  trigger again. Confirm notification + amber pulse on background.

## Risks

- xterm.js double-handling of OSC 777: verified empty
  (`grep registerOscHandler src/components/terminal-view.tsx`
  returns no matches). If a future xterm.js upgrade adds it, the
  observe-only design means we don't break — we just both fire.
- Plugin schema bump (v2): warp's parser uses
  `VERSIONED_PARSERS[version - 1]` and logs an error on unsupported
  versions. We mirror that — drop unknown versions, log once.

## Known limitations

- **Closed-tabs resolver gap**: `resolveOpenProject` walks
  `term.store.tabs`, not `recentProjects`. If a user closes every
  Claude tab for a project but still has it pinned in the sidebar,
  an OSC event for that project is silently dropped. Intentional for
  v1 — "no open tab" is a reasonable proxy for "not actively
  tracking" — but flag here so future-you doesn't treat it as a bug.
- **No `v`-field dispatch**: the slim Rust parser deserializes any
  version that happens to share v1's field names (the
  `version_2_still_parses` test demonstrates). If warp ships v2 with
  a renamed/required field, those events drop silently. Acceptable
  while `v=1` is the only published version; track a follow-up issue
  if/when v2 lands.

## Out of scope (track separately)

- Action-button notifications (#25-dependent).
- Multi-CLI-agent support (no issue yet — open if/when needed).
- OSC 9 plain-text fallback (warp uses it for Codex; not relevant
  for Klaudio).
