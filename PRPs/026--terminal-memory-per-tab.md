# PRP 026 — Terminal memory per open tab

Issue: [#113](https://github.com/willywg/klaudio-panels/issues/113), point 4.
Points 1, 2 and 5 of that issue have shipped. Point 3 was partly done in #116,
and its raw `ipc::Channel` half is still open, but it is not part of this PRP.

## Goal

Find out how much memory each open terminal costs, and cut that cost only
where the numbers show one.

**This PRP starts with a measurement, and the measurement can close it.**
Step 0 produces a table. The decision gate after it says which fix, if any,
gets built. "No change, here are the numbers" is a valid outcome. Nothing in
steps 1–3 is built without step 0's numbers justifying it.

Out of scope:
- #113 point 3 (raw `ipc::Channel`).
- Unmounting hidden tabs. Decision #9 in CLAUDE.md keeps every xterm instance
  alive so scrollback survives a tab switch, and this PRP does not reopen
  that.
- Dormant tabs. A `dormant` tab has no `TerminalView` at all
  (`App.tsx` `<Show when={status !== "opening" && status !== "dormant"}>`),
  so it already costs nothing here.

## What is known before measuring

There are three xterm surfaces. Each one creates its own `Terminal` with
`scrollback: 10_000` and its own `WebglAddon`:

| surface | file | how many stay mounted |
| --- | --- | --- |
| Agent tab (Claude / Cursor) | `src/components/terminal-view.tsx` (`onMount`, ~L116–156) | **every non-dormant tab of every open project.** `App.tsx` renders `<For each={term.store.tabs}>` over the whole store and hides the others with `visibility: hidden`, not only the active project's tabs. |
| Shell tab | `src/components/shell-terminal/shell-terminal-view.tsx` (~L95–122) | every shell tab of every project in `shellMountedProjects()` |
| Editor PTY (nvim/helix/vim) | `src/lib/editor-terminal-store.ts` (~L150–179) | kept in a store outside the component tree on purpose (see the comment at the top of that file) |

A few more things matter here:

- On every surface, `webgl.onContextLoss(() => webgl.dispose())` is the only
  context-loss handling. xterm 6 removed the canvas renderer, so a terminal
  that loses its context falls back to the **DOM renderer** for the rest of
  its life.
- WebKit caps the number of live WebGL contexts per web process. When a new
  context goes over the cap, WebKit drops the least recently used one. The
  exact cap for the WebKit on this machine (macOS 26.6.2) is **not known**,
  and measuring it is part of step 0.
- The xterm buffer stores cells as `Uint32Array` words, about 12 bytes per
  cell, plus extended attributes. That is an estimate, not a measurement: at
  200 columns × 10,000 lines of history, a full buffer could reach tens of MB.
- Claude Code (Ink) draws in the **normal** buffer, so a long agent session
  really does fill its scrollback. nvim/helix draw in the **alternate**
  screen, so an editor PTY's scrollback is barely used.
- In current WebKit, WebGL runs in a separate **GPU process**
  (`com.apple.WebKit.GPU`), not only in `com.apple.WebKit.WebContent`. A
  measurement that reads WebContent alone will miss the texture atlases.
- Versions: `@xterm/xterm` 6.0.0 and `@xterm/addon-webgl` 0.19.0.

## Step 0 — Measure (required, and it gates the rest)

You **cannot** measure in Klaudio itself (see *Isolation rules*). Instead,
build a harness that runs the same xterm code in the **same system WebKit**
Tauri uses.

### 0.1 Harness page

Put it in `scripts/bench/xterm-memory/` and commit it, so the after
measurement in step 4 uses exactly the same thing. It has two files:

- **`index.html`** plus a small entry `main.ts`, served by `bunx vite`
  pointed at that folder. It imports `@xterm/xterm`,
  `@xterm/addon-webgl`, `@xterm/addon-fit` and `@xterm/addon-unicode11`
  from the repo's `node_modules`, **with the same `Terminal` options as
  `terminal-view.tsx`** (font, `scrollback: 10_000`,
  `allowProposedApi`). It does not import any app code.
- **Query parameters:**
  - `n` — number of terminals.
  - `renderer=webgl|dom`
  - `fill` — number of history lines to write to each terminal.
  - `cols` / `rows` — default 200×50, which is roughly a full-screen tab.
  - `scrollback` — defaults to 10000.

  Each terminal sits in its own absolutely positioned div, the same way
  `App.tsx` stacks tabs. Only the last one is visible; the others are
  `visibility: hidden`, as in the app.
- **Fill content should look like an agent's output**, not `"a"` repeated:
  - lines of varying length, many near the full width;
  - SGR colors and bold (`\x1b[38;5;Nm`, `\x1b[1m`);
  - some wide characters (CJK and emoji), which exercise unicode11.

  Write with `term.write(chunk, cb)` in 64 KB chunks and wait for each
  callback. This measures a buffer that has actually been parsed, not a
  write queue.
- **Instrumentation:**
  - Count `onContextLoss` events per terminal, and record **which index**
    lost its context.
  - When every write has drained and two animation frames have passed,
    set `document.title = "READY lost=<k> lostIdx=<list>"`.
  - Switch the visible terminal once: show index 0, then go back to the last
    one. Record whether index 0 painted, and whether it was still WebGL or
    had fallen back to DOM (`term._core._renderService._renderer` class
    name, which is fine in a harness). Put that in the title too.

### 0.2 Host: a WKWebView, not a browser

Write `scripts/bench/xterm-memory/host.swift`, about 60 lines, and run it with
`swift host.swift <url>`:

- It opens an `NSWindow` with a `WKWebView` and loads the URL. WKWebView is
  the engine Tauri uses on macOS, and the system Safari/Playwright builds may
  differ from it.
- It polls `webView.title` until it starts with `READY`, then prints:
  - the title;
  - the WebContent PID, from `webView.value(forKey: "_webProcessIdentifier")`
    (private KVC, fine in a bench script).
- The GPU process PID has no public getter. Snapshot
  `pgrep -f com.apple.WebKit.GPU` **before** launching the host and diff it
  after `READY`. **Other apps own GPU and WebContent processes too**,
  including the user's running Klaudio, Safari and Cursor. Only ever read the
  PIDs that appeared after your launch, and never signal any of them.
- Then read memory:
  - `footprint -p <pid>` (phys_footprint);
  - if available, the IOSurface / IOAccelerator lines, which hold the WebGL
    textures.

  Do this for the WebContent PID and for each new GPU PID. The host then
  quits.

If `swift` cannot open a window from the CLI in this environment, fall back to
Playwright WebKit (`bunx playwright install webkit`) and **say so in the
results**. Playwright's WebKit is a separate build, so treat its absolute
numbers as indicative and trust only its per-tab slopes.

### 0.3 Matrix

Start a fresh host process for every row. Do not reuse a web process across
rows.

| run | n | renderer | fill |
| --- | --- | --- | --- |
| baseline | 1 | webgl | 0 |
| A | 1, 4, 8 | webgl | 0 |
| B | 1, 4, 8 | webgl | 10000 |
| C | 1, 4, 8 | dom | 10000 |
| D | 1, 4, 8 | webgl | 10000 with `scrollback=1000` |
| cap | 8, 12, 16, 20, 24 | webgl | 0 |

Run each row twice and report the median. From A, B, C and D, work out the
**per-tab slope** in MB for WebContent and for GPU:

- A: the WebGL context plus the empty terminal.
- B − A: the full buffer.
- B − C: what WebGL costs over DOM once the buffer is full.
- B − D: what the last 9,000 lines cost.

The `cap` runs answer three questions:
- At what `n` does the first context loss happen?
- Which terminal loses it? Is it the oldest, or the visible one?
- Does that terminal still paint afterwards?

### 0.4 Record

Post the table, the slopes and the `cap` answers as a comment on #113. Include
the macOS version and the WebKit version (`defaults read
/System/Library/Frameworks/WebKit.framework/Resources/Info.plist
CFBundleVersion`). Then **stop and report** back before building anything,
with a recommendation that applies the gate below.

### Decision gate

| finding | build |
| --- | --- |
| GPU + WebContent per-tab slope for WebGL (A, or B − C) ≥ 15 MB, **or** a context loss at n ≤ 12 | Step 1 (WebGL pool) |
| Full buffer (B − A) ≥ 20 MB per tab | Step 2 (scrollback), **editor surface only** unless the user signs off on more |
| Neither | Nothing. Close point 4 with the numbers. |

The user makes the call on this report. Don't pick the thresholds yourself if
the numbers land close to them; show them and ask.

## Step 0 result and decision (2026-09-24)

Measured and posted on
[#113](https://github.com/willywg/klaudio-panels/issues/113#issuecomment-5822971321):

| | measured | per extra tab |
| --- | --- | --- |
| An empty WebGL terminal (A) | 81 → 265 MB | 26 MB |
| A full 10k buffer, WebGL (B) | 177 → 615 MB | 62 MB |
| A full 10k buffer, DOM (C) | 154 → 449 MB | 42 MB |
| B − C, what WebGL costs | | **20 MB** |
| B − D, the last 9,000 lines | | **26 MB** |

Figures are WebContent footprint for 1 → 8 terminals, on macOS 26.6.2 with
WebKit 21624.5.1.11.3. The GPU process stays flat, at about 1 MB per tab.

No context was lost up to 24 terminals. The cell width differs between the
DOM and WebGL renderers: 8.035 px against 8 px.

**Decisions:**
- Build step 1, the WebGL pool. Its cap is set by attach latency, as
  described below.
- Build step 2 **for the editor only**.
- The user chose to **keep 10,000 lines of scrollback for agent and shell
  tabs**. Don't change them.
- The cell-width gotcha applies: skip `safeFit` while WebGL is detached.
- Attach latency on a hidden full 10k buffer was 41 ms (median of 10), so
  `WEBGL_POOL_CAP` is 3.

## Step 1 — WebGL pool (only if the gate says so)

This keeps WebGL on the terminals the user actually looks at, and puts a
ceiling on how many contexts exist at once.

- **New module `src/lib/webgl-pool.ts`, pure LRU logic with no xterm import:**
  - `createWebglPool(cap)` returns `{ touch(id), release(id), lost(id) }`.
  - `touch(id)` marks `id` as most recently used and returns what to do:
    `{ attach: boolean, detach: string[] }`. Its own id is attached if it was
    not already, and the oldest ids beyond the cap are detached.
  - `release(id)` is for unmount.
  - `lost(id)` marks a context-lost terminal as detached, so the next
    `touch` attaches again.
  - Write it as a pure function over state so `bun test` covers it the way
    `lib/restore-tabs.ts` is covered.
- **Apply it to all three surfaces, through one pool**, because WebKit's cap
  covers the whole web process. Each surface keeps its own `WebglAddon |
  undefined` and gets two small helpers:
  - `attachWebgl()`: `new WebglAddon()`, `onContextLoss` → dispose →
    `pool.lost(id)`, then `loadAddon`, inside the existing `try/catch`.
  - `detachWebgl()`: `dispose()`, then set it to `undefined`.

  Call `touch` where each surface already reacts to becoming active:
  - `terminal-view.tsx`: the `createEffect` on `props.active`.
  - `shell-terminal-view.tsx`: the equivalent effect.
  - `editor-pty-view.tsx`: `props.active`.

  Attach **before** that effect's existing `term.refresh(0, term.rows - 1)`.
- **Cap: decided by attach latency, not by a context limit.** Step 0 found no
  context loss up to 24 terminals, so the pool exists only to save memory.
  Each terminal detached from WebGL saves about 20 MB (B − C). A cap of 6
  would save almost nothing for a user with 8 tabs, so the cap has to be
  smaller. Measure it first, in the harness:
  - Time a WebGL attach on a hidden terminal with a full 10k buffer, from
    `loadAddon` to the first painted frame after it is made visible.
  - Take the median of 10 runs.
  - If it is ≤ 50 ms, set the cap to **3**. That covers the active agent tab,
    the active shell tab and one recent tab.
  - If it is more, set the cap to **6**, and put the number in the PR.

  The cap is one exported constant in `webgl-pool.ts`.

### Gotchas for step 1

- **Never re-create the `Terminal`** (decision #9). Only the addon comes and
  goes, and the buffer is untouched.
- **A renderer swap must not change `cols`/`rows`.** DOM and WebGL can
  measure cell width differently by a fraction of a pixel. If they do, a fit
  on a hidden, detached tab would change `cols`. That sends a SIGWINCH, which
  makes Claude repaint the screen, the same drift PRP 016 / #38 fixed by
  going down to one fit per activation.
  - In the harness, measure `term._core._renderService.dimensions.css.cell`
    under both renderers and record it.
  - If they differ, skip `safeFit` while a tab's WebGL is detached (both the
    `ResizeObserver` path and the window-resize path), and let the existing
    250 ms fit after activation run once WebGL is back.
- A hidden terminal on the DOM renderer still receives `pty:data`. Check that
  `writePtyChunk` flow control (`lib/pty-stream.ts`) is unaffected. It
  counts parsed bytes, not rendered ones, so it should be.
- `onContextLoss` can fire on the **visible** terminal if the cap is ever
  exceeded anyway. `pool.lost` plus the next activation brings it back.
  Don't add a retry loop.
- Keep the `console.warn` fallbacks as they are. A machine with no WebGL at
  all must behave the same as today.

## Step 2 — Scrollback (only if the gate says so)

- **Editor PTYs** (`editor-terminal-store.ts`): nvim/helix draw in the
  alternate screen, so lower `scrollback` there to 1000. No sign-off is
  needed.
- **Shell tabs and agent tabs**: **do not change them without the user's
  explicit OK.** The scrollback is the history people scroll back through,
  and for a shell tab it cannot be recovered (see the comment in
  `App.tsx` ~L1241). Put the numbers and a proposed value in the report and
  let the user decide.

## Step 3 — Docs

- CLAUDE.md, Module boundaries:
  - add a `lib/webgl-pool.ts` bullet if step 1 shipped;
  - in the `components/terminal-view.tsx` bullet, one sentence that WebGL is
    pooled and a hidden tab may be on the DOM renderer.
- CHANGELOG `[Unreleased]`, with the before/after numbers.
- Comment on #113: tick point 4, with the table.

## Step 4 — After measurement

Re-run the step 0.3 rows that apply, using the same harness and the pool
logic wired into it, or, if that is simpler, the real `webgl-pool.ts`
imported into the harness. Put before/after in the PR.

## Acceptance

1. The #113 comment has the step 0 table, the slopes, the context-cap
   answers, and the macOS and WebKit versions.
2. If step 1 shipped, in user QA on a native build (`bun tauri dev --target
   aarch64-apple-darwin`) or a release build, **never Rosetta**:
   - with 10 agent tabs open across two projects, every tab paints correctly
     when activated;
   - there is no blank panel and no welcome-banner redraw;
   - Claude does not repaint on a plain tab switch, meaning no SIGWINCH when
     the size did not change;
   - the WebContent and GPU memory of the Klaudio web processes in Activity
     Monitor go down against v1.14.0 by roughly the slope the harness
     predicted.
3. Shell tabs keep their full scrollback across tab and project switches.
4. An nvim editor still renders and scrolls correctly.
5. `bun run typecheck` and `bun test` are clean, with the pool fully covered.
   `cargo clippy --all-targets -- -D warnings` and `cargo test` are untouched
   and still clean.

## Isolation rules for whoever implements this

- **Never launch Klaudio**: debug, release, `bun tauri dev`, or a copy. App
  state is keyed on the bundle identifier, so any instance restores the
  user's real workspace and resumes their real sessions. Measurements
  in the real app, and full-app QA, are done by the user from steps written
  in the PR.
- The harness imports no app code and touches no app state. It never reads or
  writes `~/.claude`, `~/.cursor`, `~/Library/Logs/Klaudio Panels/`, or the
  app's `localStorage` / config dir.
- **Never signal a process you did not start in this task.** The WebContent
  and GPU processes of the user's Klaudio, Safari and Cursor look exactly
  like yours. Tell them apart only by the PID diff taken around your own
  launch.
- Scratch output such as raw `footprint` dumps goes under `$TMPDIR`. Only the
  harness source is committed.
