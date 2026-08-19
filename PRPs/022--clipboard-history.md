# PRP 022 — Clipboard history in the titlebar

**Issue:** [#79](https://github.com/willywg/klaudio-panels/issues/79)
**Status:** in progress
**Scope:** text-only v1, Klaudio-originated clips only

## The problem

Working several projects at once makes the clipboard a lossy channel. Claude
runs `pbcopy` to hand something over; before it reaches an email or WhatsApp,
something else overwrites it. The content is unrecoverable except by asking
Claude to print it again.

## What we build

A dropdown in the titlebar, next to the notification bell: the last 10 things
Klaudio copied, click one to put it back.

## The pivot that defines the design

The first cut watched the **system pasteboard**, polling
`NSPasteboard.changeCount`. It worked, and it was wrong: it recorded
everything — a copy from Safari, a WhatsApp message, a password. Reviewing it
in use, the ask sharpened to *only what Klaudio copied*.

That is not a predicate you can bolt onto a watcher. **The pasteboard exposes
no attribution**: `changeCount` tells you a write happened, never who made it.
There is no owner PID, no source app, nothing. Filtering by origin requires
*owning the write*.

Two rejected approximations, for the record:

- **Frontmost-app filter** — only record while Klaudio is frontmost. Ten lines,
  and it fails in exactly the situation the feature exists for: Claude running
  `pbcopy` in the background while the user reads something in another window.
- **An MCP tool Claude calls instead of `pbcopy`** — model-dependent, needs
  per-project `.mcp.json`, and captures nothing from the user's own ⌘C.

## What we do instead: own both copy paths

### 1. A `pbcopy` shim on every PTY's PATH

`spawn_pty` — the single choke point all three `pty_open*` variants funnel
through — prepends a Klaudio-owned directory to the child's `PATH` and sets
`KLAUDIO_CLIP_SOCK`. That directory holds a `pbcopy` shim which tees stdin to
the real `/usr/bin/pbcopy` and to the unix socket the app listens on.

Injection happens *after* direnv, so a project's `.envrc` cannot displace the
shim.

The shim's contract is that it must never be worse than the real `pbcopy`:

- Both branches end at `/usr/bin/pbcopy` with `"$@"` forwarded verbatim, so
  `pbcopy -pboard find` keeps working.
- The real `pbcopy`'s exit status is what the caller sees (`PIPESTATUS[1]`).
- Missing socket, dead socket, or missing `nc` all fall through to a plain
  `exec`. Recording is best-effort; breaking the user's `pbcopy` to feed a
  history panel would be a terrible trade.
- `tee` into a process substitution keeps the payload off disk. A clip may
  well be a secret and has no business in a temp file.

### 2. ⌘C inside a Klaudio terminal

Already our own code — `terminal-view.tsx`, `shell-terminal-view.tsx` and
`editor-terminal-store.ts` each report the selection through
`clipboard_record`.

### What this buys beyond correctness

Because nothing observes the system pasteboard any more, **the entire
privacy surface is gone**. The first cut needed careful handling of
`org.nspasteboard.ConcealedType` and friends so a password manager's clip
would not land in a dropdown; now such a clip is not something we could
capture even by accident. The safest handling of a secret is being structurally
unable to see it.

## Other decisions

### In-memory only

Decision #6 restricts SQLite to app settings, but the stronger reason is
privacy surface: persisting every copy to disk drags in encryption at rest, a
retention policy, and a "clear history" flow, for a feature framed as "the
last 5 or 10". A ring buffer that dies with the process delivers exactly that.

### An off switch, defaulting on

The toggle lives in the dropdown and persists in `localStorage`. The choice is
pushed to the backend on mount, before any PTY can be spawned.

### Text only in v1

Images and file URLs force a total-memory budget and an eviction policy that
text does not — a 40MB PNG cannot sit ten deep in a ring buffer. Text is capped
per entry (64KB) and bounded by count. A non-UTF-8 payload piped to `pbcopy`
is skipped rather than mangled.

### Re-copy only; pasting into the PTY is a follow-up

Clicking an entry puts it back on the pasteboard. That is the whole ask — the
clip is destined for an email or WhatsApp, not for Claude.

A "paste into the active tab" action looked free (`terminal.write` already
exists) but is not: `pty_write` sends raw bytes, while correct pasting goes
through `term.paste()`, which wraps the text in bracketed-paste markers when
the PTY has `?2004h` active. Without those markers Claude Code reads a
multi-line snippet as typed input and every newline submits the prompt. Doing
it properly means an event bus from the titlebar to `terminal-view.tsx` (the
`image-lightbox-bus.ts` pattern).

## What is still out of scope

**A copy button on Claude's rendered markdown code blocks**, the obvious
version of the original request. It needs the PTY output parsed to find where
a block starts and ends, which architectural decision #2 forbids. Claude Code
renders fenced blocks as ANSI-styled text inside a character grid; nothing in
the byte stream marks their extent, so finding one means inferring structure
from styling and indentation, and it breaks on a theme change or a wrapped
line.

The precedents that *look* like they'd license it do not:

| Precedent | Why it is allowed | Why it does not extend here |
|---|---|---|
| File-path link providers (`xterm-file-links.ts`) | **Lexical** — a regex over characters, no meaning inferred | A code block is not a token; its extent is a rendering decision |
| OSC 777 CLI-agent sniffer (`cli_agent.rs`) | **Published wire contract** (warp's protocol v1) | There is no equivalent contract for "this region is a code block" |

There is exactly one clean path, and it is not ours: **OSC 52**, the standard
terminal clipboard escape. If Claude Code emitted it on copy we would receive
the payload as a wire-level event and need no shim at all. It does not.

## Module layout

**Rust**

- `clipboard_history.rs` (new) — the ring, the shim source, the shim installer,
  the unix-socket listener, and the `clipboard_record` /
  `clipboard_history_list` / `_clear` / `_set_enabled` commands. Emits
  `clipboard:new`.
- `pty.rs` — `clipboard_history_env` prepends the shim dir to `PATH` and sets
  `KLAUDIO_CLIP_SOCK`, applied in `spawn_pty`.

**Frontend**

- `lib/clipboard-prefs.ts` — enabled flag, row preview and size formatting.
- `lib/record-clip.ts` — the ⌘C reporting call.
- `context/clipboard-history.tsx` — store, `clipboard:new` listener, initial
  `clipboard_history_list`.
- `components/clipboard-history-button.tsx` — the dropdown, modeled on
  `notification-bell.tsx`.
- `components/titlebar.tsx` — mounts it, and carries the `relative z-40` that
  makes the titlebar its own stacking context (see below).

## A UI bug this surfaced

The dropdown rendered *underneath* the diff panel's sticky repo headers. Those
are `sticky z-10`; the dropdown is `absolute z-50`, so z-index alone said the
dropdown should win. It did not, because the sticky row carried
`backdrop-blur-sm`: in WebKit a `backdrop-filter` element is promoted to its
own compositing layer and can paint over a higher-z-index element living in a
different subtree, and the titlebar `<header>` created no stacking context of
its own to contain the comparison.

Fixed at the right level — `relative z-40` on the header, which fixes all three
of its dropdowns at once — plus dropping the blur, which contributed almost
nothing behind a 95%-opaque background and was the compositing trigger.

## Acceptance

- `pbcopy` inside a Claude tab shows up in the dropdown.
- It shows up even when Klaudio is not the frontmost app.
- ⌘C on a terminal selection shows up.
- Copying in Safari, WhatsApp or a password manager does **not**.
- `pbcopy` keeps working with the app closed, with the socket gone, and with
  `-pboard` arguments.
- Clicking an entry makes ⌘V produce it.
- Toggling off stops recording; toggling back on does not backfill.
- Nothing is written to disk.
- `bun run typecheck`, `cargo clippy -- -D warnings`, `cargo test` clean.
