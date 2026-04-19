# PRP 003 — Multi-tab sessions + last-session persistence

> **Version:** 1.0
> **Created:** 2026-04-17
> **Status:** Ready
> **Phase:** Sprint 02 (PROJECT.md Phase 1.5 — multi-session)

---

## Goal

The user can open **several Claude Code sessions simultaneously** inside the same window, each in its own tab with its own independent PTY. Tabs live above the terminal (browser/iTerm style): `[session A] [session B] [+]`. Switching tabs toggles the view instantly without losing scrollback nor killing the process. Closing a tab kills only that PTY. When a project is reopened, the app **auto-resumes the last active session** of the user for that project (persisted in `localStorage`).

## Why

- **Multi-tab** is the expected UX of any modern IDE/terminal. Without it, the user must choose between working on one conversation or another — but Claude Code is a natural fit for having several live conversations (one for code, one for docs, one for experimenting).
- **Last-session persistence** removes the "which one was I using?" friction when reopening the app. It's 80% of the value of full state persistence with 20% of the effort.
- Both tasks touch the same state (which session is open, where) — doing them together avoids redesigning `TerminalContext` twice.
- The Rust backend already supports N concurrent PTYs (`HashMap<id, PtySession>` in `pty.rs`). **The work is almost 100% frontend + state management.**

## What

### User-visible behavior

1. In the right panel, above the terminal, a **tab strip** shows the open sessions.
2. Clicking "+ New session" in the sidebar → opens in a **new tab** (does not replace the active one).
3. Clicking a session in the sidebar:
   - If there's already a tab open with `--resume <id>` for that session → **activate** that existing tab.
   - Otherwise → open a **new tab** with `--resume <id>`.
4. Clicking a tab → switches to that session. Scrollback and TUI state are intact.
5. Clicking the "×" of a tab → kills only that PTY. If it was the active one, the previous tab is activated. If it was the last, the "pick a session" placeholder is shown.
6. In the sidebar, open sessions show a **visual indicator** (green dot / side border).
7. When reopening the project (or starting the app with a persisted `projectPath`), a tab is **auto-spawned** via `claude --resume <lastSessionId>`. On failure (session deleted), fall back silently to the placeholder.

### Success Criteria

- [ ] Open 2+ sessions in parallel tabs, each keeps its own scrollback when switching.
- [ ] Switching tabs doesn't kill any PTY nor restart the TUI (verify with `ps` that both `claude` processes are still alive).
- [ ] Typing input in tab A doesn't appear in tab B.
- [ ] Closing the active tab switches to the previous tab without error.
- [ ] Closing the last tab goes back to the "pick a session" placeholder.
- [ ] Clicking on a session in the sidebar that is already open in a tab doesn't spawn a second PTY (activates the existing one).
- [ ] Closing the app with an open session and reopening → that session (or the last active) appears auto-resumed in a tab.
- [ ] A `lastSessionId` deleted from the filesystem doesn't break startup (falls back to the placeholder).
- [ ] `typecheck` + `cargo check` + `cargo clippy -- -D warnings` clean.
- [ ] No regression: a single session still works identically to Sprint 01 (xterm WebGL, FitAddon, clipboard, unicode11).

---

## All Needed Context

### Project-level references (always relevant)

```yaml
- file: PROJECT.md
  why: Blueprint, especially the "Phase 1.5 multi-session" and "Phase 4 app settings" sections.
- file: CLAUDE.md
  why: Non-negotiable rules. Line 9 ("Single PTY per window in Sprint 01") must be UPDATED as part of this PRP.
- file: docs/sprint-01-results.md
  why: Backlog that feeds this sprint.
```

### Feature-specific references

```yaml
# Own — reusable prior work
- file: src-tauri/src/pty.rs
  why: Already supports N concurrent PTYs via `PtyState { sessions: Mutex<HashMap<String, PtySession>> }`. DO NOT TOUCH unless fixing a bug.
  lines: 17-19, 26-133

- file: src/context/terminal.tsx
  why: Main refactor point — moves from a single-id store to a tabs collection.
  lines: 23-119

- file: src/components/terminal-view.tsx
  why: Must accept an `id` prop (tab id) instead of reading `ctx.store.id`. Multiple instances will coexist.
  lines: 37-162

- file: src/App.tsx
  why: Main layout. Adds a tab strip + an overlay of N TerminalViews with visibility toggle.
  lines: 50-104

# OpenCode — reference pattern
- file: ~/proyectos/open-source/opencode/packages/app/src/pages/session/terminal-panel.tsx
  why: Shows how they keep several terminals mounted and toggle visibility. Structure of the tab + panel component.
  note: They use ghostty-web, we use xterm.js — the mount/show pattern applies the same.

- file: ~/proyectos/open-source/opencode/packages/app/src/context/terminal.tsx
  why: How they model "terminal state per id" vs "active id".
```

### Current repo state (relevant portions)

```
src/
├── App.tsx                       # Shell, grid [sidebar | section]
├── context/terminal.tsx          # Single-id store (REFACTOR)
├── components/
│   ├── terminal-view.tsx         # Reads ctx.store.id (REFACTOR: prop-based)
│   ├── sessions-list.tsx         # Sidebar with JSONL sessions
│   └── project-picker.tsx        # Folder picker
src-tauri/src/
├── pty.rs                        # Multi-PTY already supported
├── sessions.rs                   # read-only from ~/.claude/projects/
├── binary.rs, shell_env.rs
```

### Desired changes

```
src/
├── App.tsx                              # MODIFY: render tab strip + N overlapped terminals
├── context/terminal.tsx                 # REWRITE: tabs map + activeTabId
├── components/
│   ├── terminal-view.tsx                # MODIFY: accepts `id` prop; `ctx.get(id)` instead of `ctx.store`
│   ├── tab-strip.tsx                    # NEW: horizontal row of tabs + `+` button
│   ├── sessions-list.tsx                # MODIFY: "open in tab" indicator per sessionId
│   └── last-session.ts                  # NEW (small): localStorage helpers for lastSessionId
```

### Known gotchas & project rules

```
CRITICAL — xterm.js persistence across tab switches:
  - DO NOT destroy the `Terminal` instance on tab switch → you'd lose scrollback.
  - DO NOT use `display: none` → breaks FitAddon (it cannot measure cells on hidden
    elements) and WebGL (the canvas freezes).
  - CORRECT PATTERN: keep all TerminalViews mounted simultaneously, stacked with
    `position: absolute; inset: 0;` inside a `relative` container. Toggle with
    `z-index` + `visibility: hidden/visible` + `pointer-events: none/auto`.
  - On re-activating a tab, call `fit?.fit()` on the next frame to recompute
    if the window was resized while it was hidden.

CRITICAL — Tab id ≠ Session id:
  - The tab id is the PTY UUID (what `pty_open` returns). Stable for the lifetime of the tab.
  - The session id only exists for tabs with `--resume <id>`. "New" tabs have NO session
    id associated until Claude writes the JSONL (discovery via watcher = Sprint 03).
  - DO NOT try to correlate "new" tabs with sidebar sessions in this sprint.
    Documented as a known limitation.

CRITICAL — Sidebar click semantics:
  - Click on session X in the sidebar:
      → there's a tab with sessionId === X  → activate that tab.
      → there isn't                          → open a new tab with `claude --resume X`.
  - NEVER replace the active tab when clicking in the sidebar (breaks the tab-independence
    expectation).

CRITICAL — Minimal persistence:
  - Only `localStorage.setItem("lastSessionId:<projectPath>", sessionId)` when activating
    a tab with a defined sessionId.
  - DO NOT persist the full list of open tabs (re-spawning N PTYs on startup = unpredictable
    UX + may hang if N>3).
  - When loading the project: read the key, if there's a value → spawn a single tab with
    `--resume`. On failure (PTY exits with code ≠ 0 in <2s or `claude` writes "No such session"),
    clear the key and return to the placeholder.

LIBRARY QUIRKS:
  - xterm @6 FitAddon: `fit()` requires the container to be visible (getBoundingClientRect
    with size > 0). If the tab is hidden when the ResizeObserver fires, the fit must be
    deferred until the tab becomes visible again.
  - SolidJS createStore: mutations over nested sub-paths require the producer DSL or
    path-based setStore. For tabs[] use `setStore("tabs", tabs.length, newTab)` or
    `setStore(produce((s) => { s.tabs.push(newTab) }))`.
  - Tauri listener: each tab needs its own `listen<string>(pty:data:<id>, ...)`.
    Unlisten fns must be tracked per tab id and called on close.

NO-GOES (out of scope for this PRP, will go to Sprint 04):
  - Keyboard shortcuts (Cmd+T new tab, Cmd+W close, Cmd+1-9 activate, Cmd+Shift+[/] cycle).
  - Drag & drop tab reorder.
  - Configurable tab-open limit.
  - SQLite (localStorage is enough for this PRP).
  - Multi-window (one window with N tabs for now).
```

---

## Implementation Blueprint

### Data models / types

```ts
// src/context/terminal.tsx
export type TabStatus = "running" | "exited" | "error";

export type TerminalTab = {
  id: string;                    // PTY UUID — stable tab identity
  projectPath: string;           // PTY cwd
  sessionId: string | null;      // null for "new" tabs (until Sprint 03)
  label: string;                 // "New session" or resumed-session preview
  status: TabStatus;
  exitCode: number | null;
  error: string | null;
};

type TerminalStore = {
  tabs: TerminalTab[];
  activeTabId: string | null;
};

type DataHandler = (bytes: Uint8Array) => void;
type ExitHandler = (code: number) => void;
```

```ts
// src/components/last-session.ts
export function lastSessionKey(projectPath: string): string {
  return `lastSessionId:${projectPath}`;
}

export function getLastSessionId(projectPath: string): string | null {
  return localStorage.getItem(lastSessionKey(projectPath));
}

export function setLastSessionId(projectPath: string, sessionId: string | null): void {
  const k = lastSessionKey(projectPath);
  if (sessionId) localStorage.setItem(k, sessionId);
  else localStorage.removeItem(k);
}
```

### Tasks (in execution order)

```yaml
Task 1: Refactor TerminalContext → tabs collection
  FILE: src/context/terminal.tsx
  REWRITE:
    - Store: { tabs: TerminalTab[], activeTabId: string | null }
    - Per-tab: unlistenFns (Map<id, { data: UnlistenFn, exit: UnlistenFn }>)
    - Per-tab: handler sets (Map<id, Set<DataHandler>>, Map<id, Set<ExitHandler>>)
  API:
    - openTab(projectPath, args, opts: { label, sessionId }): Promise<string>
    - closeTab(id): Promise<void>
    - setActiveTab(id): void
    - write(id, bytes): Promise<void>
    - resize(id, cols, rows): Promise<void>
    - onData(id, handler): () => void      // per-tab subscription
    - onExit(id, handler): () => void
    - getTab(id): TerminalTab | undefined
  CLEANUP:
    - onCleanup: kill all tabs
  DO NOT: global emitter ctx.store.id — each TerminalView must query ITS tab.

Task 2: TerminalView accepts `id` prop
  FILE: src/components/terminal-view.tsx
  MODIFY:
    - props: { id: string }
    - onMount: ctx.onData(props.id, ...) / ctx.onExit(props.id, ...)
    - xterm onData handler: void ctx.write(props.id, bytes)
    - onResize handler: void ctx.resize(props.id, cols, rows)
    - onCleanup: unsubscribe + dispose xterm (NO ctx.kill — the tab lives even if the
      TerminalView unmounts due to project switch)
  FIT:
    - Expose a `refit()` method via ref or cb prop, callable when the tab becomes
      visible again (see Task 4). Internally: requestAnimationFrame → fit.fit().

Task 3: TabStrip component
  FILE: src/components/tab-strip.tsx (NEW)
  API:
    - props: {
        tabs: TerminalTab[],
        activeTabId: string | null,
        onActivate: (id: string) => void,
        onClose: (id: string) => void,
        onNew: () => void,
      }
  UI:
    - Horizontal row, ~32px height, border-b.
    - Each tab: truncated label (~24ch) + status dot (green running, gray exited,
      red error) + × button (shows on hover or when active).
    - `[+]` button at the end.
    - Overflow: horizontal scroll when there are many tabs (overflow-x-auto).
  STYLE: Tailwind v4; follow the existing dark palette (neutral-8xx).

Task 4: App.tsx — overlay of N TerminalViews
  FILE: src/App.tsx
  STRUCTURE:
    <section>
      <TabStrip ... />
      <div class="relative flex-1 min-h-0">
        <For each={tabs}>{(tab) =>
          <div
            class="absolute inset-0"
            style={{
              visibility: tab.id === activeTabId ? "visible" : "hidden",
              "pointer-events": tab.id === activeTabId ? "auto" : "none",
              "z-index": tab.id === activeTabId ? 1 : 0,
            }}
          >
            <TerminalView id={tab.id} />
          </div>
        }</For>
        <Show when={tabs.length === 0}>
          <Placeholder />
        </Show>
      </div>
    </section>
  CRITICAL:
    - createEffect: when activeTabId changes, wait a frame and call refit() of the new
      tab (reactivation may require re-measuring if the window was resized while
      hidden).

Task 5: sessions-list + "new" + close handlers
  FILE: src/App.tsx
  LOGIC:
    - handleNew(): term.openTab(projectPath, [], { label: "New session", sessionId: null })
      → setActiveTab to the new id.
    - handleSelect(sessionId): if a tab exists with sessionId === X → setActiveTab(tab.id).
      Otherwise → openTab(projectPath, ["--resume", sessionId], { label: preview, sessionId }).
    - handleCloseTab(id): await term.closeTab(id). If tabs remain and it was active →
      activate the previous. Otherwise → setActiveTab(null).
    - createEffect: when activeTab.sessionId changes, setLastSessionId(projectPath, sid).
    - createEffect: on projectPath change, killall + setLastSessionId-for-old-project is
      already saved. DO NOT auto-spawn here — the initial onMount does that.

Task 6: Auto-resume on startup
  FILE: src/App.tsx
  LOGIC:
    - onMount: if projectPath exists and getLastSessionId(projectPath) has a value →
      try openTab with ["--resume", lastId]. If onExit fires with a code ≠ 0 in <2s,
      consider it a failure: setLastSessionId(projectPath, null), closeTab, show a
      silent toast (console.info for now; toast UI is out-of-scope).

Task 7: Sidebar — "open in tab" indicator
  FILE: src/components/sessions-list.tsx
  ADD prop: openSessionIds: Set<string>
  RENDER:
    - If session.id ∈ openSessionIds: add a green dot on the left, class "border-l-green-500"
      (without overriding the active border that already paints indigo).
    - The active tab in the tab strip is not necessarily the "active" sidebar session — the
      sidebar paints the active-tab's sessionId as "active" (consistent with Sprint 01).

Task 8: Update CLAUDE.md rule #9
  FILE: CLAUDE.md
  MODIFY line 9:
    before: "Single PTY per window in Sprint 01. Switching session kills the current
            child and spawns a new one. Multi-tab is Sprint 02; don't pre-build state for it."
    after: "Multi-PTY per window with tabs (Sprint 02+). Each tab is an independent
           child. Closing a tab kills only that PTY. Tab switch toggles visibility
           (never re-creates xterm). Last active session per project is persisted in
           localStorage; auto-resume on reopen."
```

### Pseudocode (critical details)

```ts
// src/context/terminal.tsx — skeleton of the refactor
export function makeTerminalContext() {
  const [store, setStore] = createStore<TerminalStore>({ tabs: [], activeTabId: null });

  const unlistens = new Map<string, { data: UnlistenFn; exit: UnlistenFn }>();
  const dataHandlers = new Map<string, Set<DataHandler>>();
  const exitHandlers = new Map<string, Set<ExitHandler>>();

  async function attachListeners(id: string) {
    const dUn = await listen<string>(`pty:data:${id}`, (e) => {
      const bytes = base64ToBytes(e.payload);
      const set = dataHandlers.get(id);
      if (set) for (const h of set) h(bytes);
    });
    const xUn = await listen<number>(`pty:exit:${id}`, (e) => {
      setStore(
        "tabs",
        (t) => t.id === id,
        produce((tab) => {
          tab.status = "exited";
          tab.exitCode = e.payload;
        }),
      );
      const set = exitHandlers.get(id);
      if (set) for (const h of set) h(e.payload);
    });
    unlistens.set(id, { data: dUn, exit: xUn });
  }

  async function openTab(
    projectPath: string,
    args: string[],
    opts: { label: string; sessionId: string | null },
  ): Promise<string> {
    const id = (await invoke("pty_open", { projectPath, args })) as string;
    const tab: TerminalTab = {
      id,
      projectPath,
      sessionId: opts.sessionId,
      label: opts.label,
      status: "running",
      exitCode: null,
      error: null,
    };
    setStore(produce((s) => {
      s.tabs.push(tab);
      s.activeTabId = id;
    }));
    await attachListeners(id);
    return id;
  }

  async function closeTab(id: string): Promise<void> {
    try { await invoke("pty_kill", { id }); } catch { /* ignore */ }
    const un = unlistens.get(id);
    if (un) { un.data(); un.exit(); unlistens.delete(id); }
    dataHandlers.delete(id);
    exitHandlers.delete(id);
    setStore(produce((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx >= 0) s.tabs.splice(idx, 1);
      if (s.activeTabId === id) {
        s.activeTabId = s.tabs.length > 0 ? s.tabs[Math.max(0, idx - 1)].id : null;
      }
    }));
  }
  // write/resize/onData/onExit similar, always taking id
  // onCleanup: for (const id of [...unlistens.keys()]) await closeTab(id)
}
```

```tsx
// src/App.tsx — overlay pattern (simplified)
<div class="relative flex-1 min-h-0">
  <For each={term.store.tabs}>
    {(tab) => {
      const isActive = () => tab.id === term.store.activeTabId;
      return (
        <div
          class="absolute inset-0 flex flex-col"
          style={{
            visibility: isActive() ? "visible" : "hidden",
            "pointer-events": isActive() ? "auto" : "none",
          }}
        >
          <TerminalView id={tab.id} />
        </div>
      );
    }}
  </For>
  <Show when={term.store.tabs.length === 0}>
    <Placeholder />
  </Show>
</div>
```

---

## Validation Loop

### Level 1: Syntax & style

```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

Rust should pass without changes (we don't touch the backend unless we find a bug during integration).

### Level 2: Unit tests

Few — this sprint is almost 100% UI/state. Candidates:

- `context/terminal.test.ts` (if we decide to add vitest — not present yet): unit over `openTab` → store.tabs.length === 1 and correct activeTabId; `closeTab` on active → activates the previous.
- Don't add vitest just for this if it doesn't exist yet — defer to Sprint 04.

### Level 3: Integration / manual (full golden path)

```bash
bun tauri dev
```

Steps (all must pass):

1. **Open a project** with 2+ sessions in `~/.claude/projects/`. Check it auto-resumes the last-used one (if there's a `lastSessionId`). On first launch, placeholder is visible.
2. **Click "+ New session"** → a new tab appears, active. The terminal shows Claude Code's welcome.
3. **Click another session in the sidebar** → a second tab opens with `--resume`. The previous one is not killed (verify with `ps aux | grep claude` → 2 processes).
4. **Type in tab B, switch to A** → input only appears in B. A's content is intact, full scrollback.
5. **Generate scroll in A** (several commands), switch to B, come back to A → A's scrollback intact.
6. **Click a session X in the sidebar that is already open as a tab** → that tab is activated, NO third PTY is spawned (`ps` still shows 2).
7. **Resize the window** while on tab A → tab A adapts. Switch to B → B also adapts (refit on activate).
8. **Close the active tab** with × → the previous is activated, B's PTY dies (`ps` → 1 process).
9. **Close the last tab** → placeholder visible. `ps` → 0 claudes.
10. **Switch project** → all tabs die. The new project shows its own `lastSessionId` (or placeholder if none).
11. **Close and reopen the app** with a project that had open tabs → auto-resume only the last active session (not all tabs — that's the documented decision).
12. **Manually delete** `~/.claude/projects/<encoded>/<lastSessionId>.jsonl` and reopen the app → no crash; clean fallback to placeholder + key cleared.

Sprint 01 regression (must still work):

- [ ] WebGL active, unicode11 active (Claude icon renders correctly).
- [ ] Cmd+C/V/K still work in the active tab.
- [ ] `bun tauri dev` starts with no new console warnings.

---

## Final Checklist

- [ ] `bun run typecheck` clean
- [ ] `cargo check` + `cargo clippy -- -D warnings` clean
- [ ] 12 manual integration steps pass
- [ ] CLAUDE.md rule #9 updated
- [ ] PROJECT.md: add Sprint 02 to the status table as "done" when closed
- [ ] `docs/sprint-02-results.md` created with: LOC, concurrent PTYs validated, known limitations (new-tab not indexed in the sidebar until Sprint 03)

---

## Anti-Patterns to Avoid

- ❌ **`display: none`** to hide inactive tabs → breaks FitAddon and WebGL.
- ❌ **Destroy the `Terminal` instance** on tab switch → loses scrollback; use visibility toggle.
- ❌ **Correlate "new" tabs with sidebar sessions** → requires JSONL watcher, Sprint 03.
- ❌ **Persist the full list of open tabs** → scope creep + unpredictable UX on startup.
- ❌ **SQLite in this sprint** → localStorage is enough; SQLite is Sprint 03/04.
- ❌ **Keyboard shortcuts** (Cmd+T/W/1-9) → out of scope.
- ❌ **Replace the active tab** when clicking in the sidebar → breaks expected independence.
- ❌ **Parallel spawn of N PTYs on startup** from persistence → only `lastSessionId`.
- ❌ **Call `ctx.kill()` in TerminalView's `onCleanup`** → unmounting the view must NOT kill the PTY (the tab may be mounted/hidden).

---

## Notes

**Design decision — tab strip above the terminal (option A, chosen by the user):**
Browser/iTerm-style tabs above the terminal. Rejected: sidebar indicators (option B) — tabs are the universal pattern for "multiple instances of the same type" and the sidebar is already loaded with history + buttons.

**Known limitation — "new" tabs without correlated sessionId:**
When creating a new tab (`claude` without `--resume`), we don't know its real sessionId until Claude writes the JSONL. In this sprint the tab lives with `sessionId: null` and its label is "New session". The sidebar won't mark it as open (it can't: it only knows ids from the JSONL). Sprint 03 will add the JSONL watcher that allows matching them after the fact.

**Follow-ups for Sprint 04 (note on close):**
- Standard keyboard shortcuts (Cmd+T/W/1-9, cycling).
- Drag & drop reorder.
- Migrate `lastSessionId` to SQLite along with other app settings.
- Toast UI for silent failures (e.g. `--resume` to a deleted session).

**Confidence for one-pass success: 8/10.** The backend is already prepared (multi-PTY), the context refactor is mechanical but requires care with per-id handler semantics and the visibility-toggle pattern.
