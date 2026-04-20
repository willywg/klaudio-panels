# Sprint 04 — Git + Diff viewer

> **Tracking doc** for the PRP at `PRPs/005--git-and-diff-viewer.md`. Keep changes here minimal; the PRP is the source of truth.

## Why now

Sprint 03 shipped the file tree but without diffs the tree is "just a list". The diff viewer is the single feature that turns cc-ui into an IDE-lite around `claude`, which is the product differentiator over running the CLI in iTerm.

## Scope (v1)

- `git.rs` with three commands: `git_status`, `git_summary`, `git_diff_file` (workdir vs HEAD).
- Badges (A/M/D/?) in the file tree + `+N −M` pill in the titlebar.
- Right-side resizable diff panel next to the terminal, powered by `@pierre/diffs`.
- Refresh piggybacks on `fs:event:<projectPath>` (150ms fs debounce + 300ms coalesce in the frontend).
- Read-only. No stage/unstage, no commit, no accept/reject hunks.

## Out of scope (explicit deferrals)

- Staged vs workdir toggle.
- Commit panel.
- Rename detection.
- Diff between arbitrary commits.
- Multi-file side-by-side view.

## Risks

- `@pierre/diffs` has React + vanilla subexports; we use vanilla. Styling registration path may need a manual `import "@pierre/diffs/..."` depending on how the package registers CSS.
- Splitter + `xterm.js` FitAddon resize loop — solved pattern from Sprint 02 (`refresh()` on visibility change), reuse.
- Large repos (>10k files) may make `git_status` sluggish. Guarded by `too_large` at the per-file level; repo-wide we accept the cost in v1.

## Success definition

All 20 QA steps in PRP 005 pass. Tag `v0.4.0` on merge to main.
