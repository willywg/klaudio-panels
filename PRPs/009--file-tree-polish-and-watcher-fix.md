# PRP 009: File tree polish (icons + actions) + watcher fix

> **Version:** 1.0
> **Created:** 2026-04-21
> **Status:** In Progress

---

## Goal

The **Files** sidebar tab should look and feel like a first-class project
explorer: language-aware file icons with per-type colors (OpenCode /
VS Code style), and a compact header with four actions — **New file**,
**New folder**, **Refresh**, **Collapse all**. External file creations
(Claude writing a file through its `Write` tool, `git checkout`, etc.)
must appear in the tree without the user having to collapse/expand the
parent — the `notify` watcher is currently dropping those events.

## Why

- Current tree uses 5 lucide icons for every file → visually flat,
  hard to scan. `Dockerfile`, `.env`, `pyproject.toml`, `uv.lock`,
  `.gitignore` all render identically.
- No way to create files/folders from the UI — user has to jump to
  a terminal or editor for every trivial create.
- **Real bug**: when Claude finishes a tool call that writes a new
  file, the tree doesn't show it. User-reported. Root cause is not
  a frontend issue — the `notify` FSEvents backend on macOS reports
  new files as `Modify(ModifyKind::Any)` in many cases, and our
  Rust handler only emits `Created` on explicit `EventKind::Create(_)`.
  Everything else becomes a `Modified` payload, which the frontend
  discards (`use-file-tree.ts:157`).

## What

Three independent but bundled changes:

### 1. Watcher normalization (bug fix — priority 1)

Rewrite `event_to_payloads` in `src-tauri/src/fs.rs` so the emitted
payload is derived from **filesystem state at event time**, not from
the `EventKind` enum. For every `notify::Event`:

- 2-path `Modify(Name(_))` → `Renamed { from, to }`.
- Otherwise for each path: `path.exists()` → `Created { path, is_dir }`;
  else → `Removed { path }`.

The frontend `applyFsEvent` is already idempotent (dedupe in
`use-file-tree.ts:126`), so emitting `Created` for a file that's
already in the tree is harmless.

### 2. Language-aware icons (frontend polish)

Expand `src/lib/file-icon.ts` from an extension→icon map to a
`{ Icon, colorClass }` map that covers ~20 common filetypes plus
filename-based matches (`Dockerfile`, `Makefile`, `LICENSE`,
`.gitignore`, `.env*`, `*.lock`, `README*`). Pass the color class
through `TreeNode` so the icon is visibly color-coded.

### 3. Header action bar (UX)

Add a 28px header row above the tree with four icon buttons:

| Action        | Behavior                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| New file      | Inline input at tree root; Enter creates, Esc cancels. Creates under root or selected folder.           |
| New folder    | Same pattern.                                                                                           |
| Refresh       | Invalidate root `loaded` flag + re-list; preserves expanded set by path.                                |
| Collapse all  | Walk the tree, set `expanded = false` on every loaded directory except root.                            |

### Success Criteria

- [ ] Creating a file from a terminal (`touch foo.ts`) or from Claude
      (`Write` tool) makes the new file appear in the tree within ~200ms,
      no expand/collapse needed.
- [ ] File tree shows distinct colored icons for at least: `.ts`, `.rs`,
      `.py`, `.md`, `.json`, `.yaml`, `.env`, `.lock`, `Dockerfile`,
      `Makefile`, `.gitignore`, `README.md`.
- [ ] Clicking **+ file** shows an inline input; typing `foo.ts` +
      Enter creates the file and selects it. Esc cancels cleanly.
- [ ] Clicking **refresh** re-reads the root directory; any stale
      entries are removed, any new ones appear, previously expanded
      directories stay expanded if their path still exists.
- [ ] Clicking **collapse all** collapses every directory; root itself
      stays expanded (consistent with `root.expanded = true` invariant).
- [ ] Typecheck + `cargo check` + `cargo clippy -- -D warnings` clean.

---

## All Needed Context

### Project-level references
```yaml
- file: CLAUDE.md
  why: Rule 7 — "Filesystem + git are the source of truth for file state.
        No custom index." → the watcher normalization must keep that
        invariant: probe the FS, don't shadow-track what's been emitted.
  why: Rule 11 — LRU cap of 3 per-project watchers. Do NOT bump this.
```

### Feature-specific references
```yaml
- file: src-tauri/src/fs.rs
  why: Current watcher implementation
  lines: 130-186 — event_to_payloads

- file: src/components/file-tree/use-file-tree.ts
  why: applyFsEvent idempotency (already dedupes in case of duplicate created)
  lines: 120-166

- file: src/lib/file-icon.ts
  why: Current icon map (to expand)

- file: src/components/file-tree/tree-node.tsx
  why: Where the icon is rendered (needs color-class prop)

- file: src/components/file-tree/file-tree.tsx
  why: Where the header will be injected; where refresh/collapse wire

- url: https://docs.rs/notify/latest/notify/event/enum.EventKind.html
  why: FSEvents on macOS often collapses Create + initial Write into a
       Modify(Any) event — documented limitation
  critical: Don't rely on EventKind granularity; probe existence
```

### Known gotchas

```
CRITICAL — macOS FSEvents:
- `notify` on macOS uses FSEvents which coalesces rapid events. A file
  created then immediately written (the typical Claude Write flow)
  can arrive as a single Modify(Any) event, NOT Create(File) +
  Modify(Data). Our handler must not assume the kind.

CRITICAL — idempotency:
- `use-file-tree.ts:126` already dedupes by path: `if (parentNode.children
  .some((c) => c.path === ev.path)) return;`. Safe to emit Created
  multiple times for the same path. Don't try to track "already emitted"
  in Rust.

CRITICAL — is_relevant still filters:
- Don't move the gitignore / hidden check out of is_relevant. Any path
  whose component starts with "." must still be dropped (otherwise
  `.git/index.lock` floods the tree every git op).

LIBRARY QUIRKS:
- SolidJS <For> doesn't re-render siblings on array changes to the same
  index. The inline-input row is rendered via a conditional <Show>
  outside the <For>, OR prepended to the flattened array when active.
- Tauri capabilities: fs_create_file / fs_create_dir are custom commands
  — they don't need "fs:" plugin permission, just the standard
  "allow-invoke" for our own commands, which is already wildcarded.
```

---

## Implementation Blueprint

### Tasks (in execution order)

```yaml
Task 1: Rust — watcher normalization
  - MODIFY: src-tauri/src/fs.rs
  - REWRITE: event_to_payloads — branch on Modify(Name(_)) for renames,
    else probe path.exists() and emit Created or Removed.
  - TEST: run app, from outside (touch / rm), verify tree updates.

Task 2: Rust — create commands
  - MODIFY: src-tauri/src/fs.rs
  - ADD: fs_create_file(path) — error if exists, std::fs::write empty.
  - ADD: fs_create_dir(path) — error if exists, std::fs::create_dir.
  - REGISTER: in src-tauri/src/lib.rs invoke_handler.

Task 3: Frontend — icon map expansion
  - REWRITE: src/lib/file-icon.ts to return { Icon, colorClass }.
  - ADD: by-filename matches for Dockerfile, Makefile, LICENSE,
    .gitignore, .env, .env.example, *.lock, package.json, tsconfig.json,
    README*.
  - COLORS: use tailwind text-* classes (blue-400, orange-400, yellow-400,
    red-400, green-400, purple-400, gray-400, cyan-400).

Task 4: Frontend — tree-node icon color
  - MODIFY: src/components/file-tree/tree-node.tsx
  - UPDATE: call site to consume new { Icon, colorClass } shape.
  - KEEP: folder icons unchanged (indigo-400 / neutral-400).

Task 5: Frontend — store additions
  - MODIFY: src/components/file-tree/use-file-tree.ts
  - ADD: refresh() — reset root.loaded, call loadChildren(projectPath),
    re-apply expanded set from a snapshot to preserve state.
  - ADD: collapseAll() — produce/walk, set expanded = false everywhere
    except root.

Task 6: Frontend — header bar
  - MODIFY: src/components/file-tree/file-tree.tsx
  - ADD: 28px header with 4 icon buttons (FilePlus, FolderPlus,
    RotateCw, FoldVertical from lucide-solid).
  - ADD: inline-create state machine ({ kind: "file" | "folder" | null,
    input: string }). Render as a pseudo-row at depth 0 when active.
  - WIRE: refresh → store.refresh(); collapseAll → store.collapseAll();
    createFile/Dir → invoke then toast on error.
```

### Pseudocode — watcher fix

```rust
fn event_to_payloads(event: &notify::Event) -> Vec<FsEventPayload> {
    let mut payloads = Vec::new();
    match &event.kind {
        EventKind::Modify(notify::event::ModifyKind::Name(_))
            if event.paths.len() == 2 =>
        {
            payloads.push(FsEventPayload::Renamed {
                from: event.paths[0].to_string_lossy().into_owned(),
                to:   event.paths[1].to_string_lossy().into_owned(),
            });
        }
        _ => {
            // CRITICAL: probe existence rather than trusting EventKind.
            // FSEvents on macOS coalesces Create + initial Write into a
            // Modify(Any) event, which the old code dropped as "Modified"
            // and the frontend ignored.
            for p in &event.paths {
                if p.exists() {
                    payloads.push(FsEventPayload::Created {
                        path: p.to_string_lossy().into_owned(),
                        is_dir: p.is_dir(),
                    });
                } else {
                    payloads.push(FsEventPayload::Removed {
                        path: p.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }
    payloads
}
```

### Pseudocode — icon map

```typescript
// src/lib/file-icon.ts
import { File, FileCode2, FileCog, FileImage, FileText, FileLock2, ... } from "lucide-solid";

type IconEntry = { Icon: typeof File; color: string };

const BY_NAME: Record<string, IconEntry> = {
  "dockerfile":    { Icon: Container,  color: "text-sky-400" },
  "makefile":      { Icon: Hammer,     color: "text-red-400" },
  ".gitignore":    { Icon: GitBranch,  color: "text-orange-400" },
  ".env":          { Icon: SlidersHorizontal, color: "text-amber-400" },
  "package.json":  { Icon: Package,    color: "text-red-400" },
  "tsconfig.json": { Icon: FileCog,    color: "text-blue-400" },
  "license":       { Icon: Scale,      color: "text-neutral-400" },
};

const BY_EXT: Record<string, IconEntry> = {
  ".ts":    { Icon: FileCode2, color: "text-blue-400" },
  ".tsx":   { Icon: FileCode2, color: "text-blue-400" },
  ".rs":    { Icon: FileCode2, color: "text-orange-400" },
  ".py":    { Icon: FileCode2, color: "text-yellow-400" },
  ".md":    { Icon: FileText,  color: "text-sky-400" },
  ".json":  { Icon: FileCog,   color: "text-yellow-300" },
  ".lock":  { Icon: FileLock2, color: "text-neutral-500" },
  // ...
};

export function iconForFile(name: string): IconEntry {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith(".env")) return BY_NAME[".env"];
  if (lower.startsWith("readme")) return { Icon: FileText, color: "text-sky-400" };
  const dot = name.lastIndexOf(".");
  if (dot < 0) return { Icon: File, color: "text-neutral-500" };
  const ext = name.slice(dot).toLowerCase();
  return BY_EXT[ext] ?? { Icon: File, color: "text-neutral-500" };
}
```

### Pseudocode — header

```tsx
// Header injected at top of <FileTree>
<div class="h-7 flex items-center justify-between px-2 border-b border-neutral-800/60">
  <span class="text-[10px] uppercase tracking-wide text-neutral-500">Explorer</span>
  <div class="flex gap-0.5">
    <IconBtn title="New File"     onClick={() => startCreate("file")}   icon={FilePlus} />
    <IconBtn title="New Folder"   onClick={() => startCreate("folder")} icon={FolderPlus} />
    <IconBtn title="Refresh"      onClick={() => store().refresh()}     icon={RotateCw} />
    <IconBtn title="Collapse All" onClick={() => store().collapseAll()} icon={FoldVertical} />
  </div>
</div>
```

### Integration points

```yaml
TAURI_REGISTRATION:
  - file: src-tauri/src/lib.rs
  - add to: invoke_handler![..., fs_create_file, fs_create_dir]

CONTEXT_WIRING:
  - no context changes; FileTree already consumes makeFileTreeStore
```

---

## Validation Loop

### Level 1: Syntax & style
```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

### Level 2: Manual integration

```bash
bun tauri dev
```

**Test cases:**

1. **External create (bug fix)** — from an outside terminal:
   ```bash
   cd <project>
   touch foo.ts
   ```
   → `foo.ts` appears in tree within ~200ms without interaction.

2. **External delete** — `rm foo.ts` → disappears.

3. **External rename** — `mv foo.ts bar.ts` → `foo.ts` gone, `bar.ts`
   present, sort position correct.

4. **Claude writes file** — ask Claude `write hello.md at root with
   body "hi"` → `hello.md` appears after Claude's tool call.

5. **Icons** — open a project with `.ts`, `.rs`, `.py`, `.md`,
   `Dockerfile`, `.gitignore`, `package.json`, `.env`. Each shows a
   distinct color.

6. **+ file** — click, type `newtest.ts`, Enter → file created.
   Hit Esc in another try → input disappears, nothing created.

7. **+ folder** — same flow with a dir name.

8. **Refresh** — add a file externally, click refresh → appears
   (redundant with test 1 but covers the code path).

9. **Collapse all** — expand several folders, click → all collapse;
   root stays visible.

---

## Final Checklist

- [ ] Frontend typecheck passes
- [ ] `cargo check` + `cargo clippy -- -D warnings` clean
- [ ] External file creation updates the tree
- [ ] Claude `Write` tool updates the tree
- [ ] Icons visibly distinct for ≥10 filetypes
- [ ] Four action buttons all work; inline inputs cancel cleanly
- [ ] No regression in drag-drop from tree → terminal
- [ ] No regression in context menu (Open in / Copy path / Reveal)

---

## Anti-Patterns to Avoid

- ❌ Don't introduce a custom "files I've emitted" index in Rust to
  dedupe — the frontend already dedupes by path.
- ❌ Don't use `prompt()` for new-file/new-folder; inline input matches
  VS Code and keeps us in the Tauri window.
- ❌ Don't bump the `WATCHER_CAPACITY` LRU cap from 3 (CLAUDE.md rule 11).
- ❌ Don't install an icon-pack dep (`@iconify`, `vscode-icons`). Lucide
  already covers what we need; keeping bundle lean matters more than
  matching VS Code pixel-for-pixel.
- ❌ Don't fetch directory listings on every `modified` event — frontend
  still ignores modified; only created/removed/renamed patch the tree.

---

## Notes

- Icon set will look "like" OpenCode / VS Code but won't match 1:1;
  this is deliberate — lucide's shape language differs. Color coding
  carries most of the scan-ability win.
- Inline create defaults to the **root** for v1. Context-menu
  entries for "New file here" in a selected folder are deferred
  (would require routing the selection into the input's target dir;
  straightforward follow-up but out of scope).
- Future work: drag to reorder / move; per-folder "New file here" in
  context menu.
