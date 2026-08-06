# PRP 021: Image preview + hover thumbnails and lightbox for terminal image paths

> **Version:** 1.0
> **Created:** 2026-08-06
> **Status:** Draft
> **Tracks:** [#73](https://github.com/willywg/klaudio-panels/issues/73)

---

## Goal

Make images visible in two places they currently aren't:

1. **The file preview** — opening a `.png` from the file tree or the diff
   panel today renders `Binary file — not shown.`
2. **The terminal** — Claude Code prints image references as plain text
   (`> [image] ~/proyectos/construct-ai/qa2278-01.jpeg (195.9KB)`). Hovering
   such a path should float a thumbnail; clicking it should open a
   full-screen lightbox.

## Why

Claude Code is a TUI: when it hands back a screenshot it has no way to show
it, so it prints the path. Our terminal, though, is xterm.js inside a
webview — the pixels are one `<img>` away. The workflow this unblocks is
concrete and recurring: Claude runs a Playwright QA pass, writes four
screenshots, and lists them. Today looking at them means leaving the app.

The fallback (open them from the file tree) is closed too, because
`FilePreview` treats every image as an unrenderable binary.

## Verdict on true inline thumbnails

**Rejected — not achievable inside the grid.** xterm.js renders a fixed
character grid. `Terminal.registerDecoration` (typings L1157) anchors an
overlay to a buffer line, but nothing in the API can make a row taller or
push subsequent rows down. An 8-row thumbnail would paint over the output
that follows it, and would drift on reflow.

The reference the user pointed at — the Claude iPhone app rendering
screenshots inline — is a DOM message list, not a terminal. It can allocate
arbitrary vertical space per message. A real TUI cannot, so that layout is
not reproducible without abandoning the terminal.

**Accepted instead:** `ILink` exposes optional `hover(event, text, range)`
and `leave(event, text, range)` (typings L1371/L1379). Hover floats a
thumbnail *above* the grid in an absolutely-positioned overlay; click opens
a lightbox. The buffer is never touched, nothing reflows, and both surfaces
degrade to today's behaviour if the file is gone.

## Relationship to non-negotiable decision #2

`CLAUDE.md` forbids parsing PTY output. This does not violate it.

Decision #2 targets *semantic* inference — "what did Claude just do?". A
link provider is lexical: it matches path-shaped tokens in the rendered
buffer text, exactly as `makeFileLinkProvider` (⌘-click a source path) and
`makeBareUrlLinkProvider` (click a bare domain) already do in production.
This PRP extends that shipped machinery to one more token shape. No frame
is interpreted, no state is inferred, and the bytes still reach xterm.js
unchanged.

## What changes

### 1. New Rust command `read_image` (`src-tauri/src/file_read.rs`)

```rust
pub struct ImagePayload {
    pub path: String,
    pub mime: String,
    /// base64 of the raw file, for a `data:` URL.
    pub data: String,
    pub bytes: u64,
}

#[tauri::command]
pub fn read_image(path: String) -> Result<ImagePayload, String>
```

Deliberately **not** routed through `resolve_rel`. The images Claude writes
routinely live under a different project than the one that's open, and
project-scoping them means the feature doesn't work for its motivating case.

The boundary is narrowed a different way instead:

- **Extension allowlist** — `png jpg jpeg gif webp bmp ico avif svg`.
  Anything else is refused before a byte is read.
- **Content sniffing** — the magic bytes must agree with the extension
  (SVG is text, so it's matched by a leading `<?xml`/`<svg` probe). A
  `.png` that is really a shell script is refused, and the `mime` we hand
  the webview is derived from the *content*, not from the name.
- **Size cap** — `MAX_IMAGE_BYTES = 12 MiB`. base64 inflates by 4/3, so
  this is the practical ceiling for a data URL.
- **Files only** — no directories, symlinks resolved before the check.

Every other file keeps today's project-root restriction: `read_file_bytes`
is untouched.

`~` is expanded host-side so the frontend never has to know the home dir.

### 2. `src/lib/image-files.ts`

Shared extension allowlist + `isImagePath(path)`, used by the preview, the
link provider and the lightbox. One list, three consumers.

### 3. `FilePreview` renders images

When `isImagePath(props.relPath)`, skip the text/Shiki path entirely and
fetch via `read_image`, rendering a centred, `object-contain` `<img>` with a
click-to-zoom toggle (fit ⇄ 1:1) and a footer showing dimensions and size.
The `Binary file — not shown.` placeholder stays for everything else.

### 4. `xterm-file-links.ts` learns `~/` and absolute paths

Current `PATH_RE` can't match `~/proyectos/…`: `~` is outside `[\w.@-]`
and there is no alternation for it, so those tokens are invisible. Add a
leading `(?:~\/|\/)?` branch.

Ordering matters — the bare-URL provider must keep priority over this one
(PRP 020), so registration order is unchanged.

### 5. Hover thumbnail + lightbox in `terminal-view.tsx`

The link provider gains `hover`/`leave` for links whose path passes
`isImagePath`. Hover fetches (cached per path+mtime) and positions a small
overlay near the link's range, clamped to the terminal's bounds. Leave
tears it down. ⌘-click opens `ImageLightbox`.

`terminal-view.tsx` mounts the overlay inside `Terminal.element` with the
`xterm-hover` class, which the typings note is required so the hover
element doesn't eat mouse events (L1364-1365).

### 6. New `src/components/image-lightbox.tsx`

Full-screen overlay: Esc or backdrop click closes, arrow keys move between
images found on the same terminal line, footer shows the path with a copy
button. Rendered once at app root and driven by a tiny signal bus
(`src/lib/image-lightbox-bus.ts`), following the existing
`selected-file-bus` / `terminal-focus-bus` pattern rather than threading
props through four components.

## Out of scope

- Inline thumbnails occupying grid rows (rejected above).
- SIXEL / iTerm2 inline-image protocols (`@xterm/addon-image`). Claude Code
  emits neither; adding the addon buys nothing today.
- Editing, rotating or annotating images.
- Video and PDF preview.

## Risks

| Risk | Mitigation |
|---|---|
| Reading outside the project root widens the file-access surface | Image extensions only, content-sniffed, size-capped, read-only, and `read_file_bytes` keeps its restriction |
| Large base64 strings crossing the IPC bridge | 12 MiB cap; hover thumbnails reuse the same cached payload as the lightbox |
| Hover overlay stealing terminal mouse events | Mount inside `Terminal.element` with the `xterm-hover` class, per the xterm typings |
| Path regex widening causes false-positive links | The `~/` and `/` branches still require an extension; image-specific behaviour is additionally gated on `isImagePath` |

## Verification

- Rust unit tests over a temp dir: allowlisted extension passes; a `.txt`
  is refused; a `.png` whose bytes are not a PNG is refused; a file over the
  cap is refused; `~` expansion resolves.
- `isImagePath` unit tests.
- Manual: open a `.png` from the file tree; hover and click an `[image]`
  path in a real Claude session; confirm a path pointing at a deleted file
  degrades to today's no-op.
