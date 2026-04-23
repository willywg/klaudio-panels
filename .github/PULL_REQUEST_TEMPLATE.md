<!--
Thanks for sending a PR! A few things to keep in mind:

- Klaudio Panels is a thin shell around `claude`. We don't parse PTY output.
- Tauri v2 + SolidJS on the frontend, Rust on the backend.
- CLAUDE.md in the repo root lists the architectural non-negotiables.

If this is your first PR here, take a look at CONTRIBUTING.md.
-->

## What this does

<!-- One or two sentences on the change. -->

## Why

<!-- Link to the issue, PRP, or discussion that motivated it. -->

## How to test

1.
2.
3.

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `cd src-tauri && cargo clippy -- -D warnings` passes
- [ ] Manually smoke-tested in `bun tauri dev`
- [ ] Updated `CHANGELOG.md` (if user-facing)
- [ ] Updated `CLAUDE.md` / docs (if architectural)

## Screenshots / screen recording

<!-- Optional for backend-only changes, very helpful for anything visible. -->
