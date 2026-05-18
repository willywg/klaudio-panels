# PRP 020: Clickable bare-domain URLs + open-url diagnostics

> **Version:** 1.0
> **Created:** 2026-05-18
> **Status:** Draft
> **Tracks:** [#45](https://github.com/willywg/klaudio-panels/issues/45)

---

## Goal

Make scheme-less URLs (`app.constructai.la`, `linear.app/foo`,
`github.com/user/repo`) clickable from any terminal surface, route
them to the system browser via the existing opener handoff, and
close the diagnostic gap that hides `openUrl` failures from the
log file end-users already ship.

## Why

Two intertwined problems surfaced when the user reported "URLs
don't open anymore" against v1.7.0:

1. **WebLinksAddon's regex requires `https?://`.** Anything without
   a scheme — extremely common in Claude's tool output — is invisible
   to it. Hover does nothing, ⌘+click does nothing.

2. **The file-link regex silently hijacks bare domains.**
   `src/lib/xterm-file-links.ts` PATH_RE:

   ```
   (?:^|[\s(["'`])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[\w]{1,10}(?::\d+(?::\d+)?)?)
   ```

   Greedy backtracking matches `app.constructai.la` as `app.constructai`
   + `.la` "extension". ⌘+click routes the "file" to `diffPanel.openFile`,
   which then opens an empty preview tab for a path that doesn't exist.
   Same story for `linear.app` → "linear" + `.app`.

3. **`openUrl` failures are unobservable in prod.**
   `src/lib/open-url.ts:11` swallows the rejection with `console.warn`.
   `installGlobalErrorForwarding` (`src/lib/debug-log.ts:15`) only
   forwards `window.error` + `window.unhandledrejection`, not console
   output. So when something *does* go wrong with the opener (Tauri ACL,
   NSWorkspace, scope), the user sees a no-op click and we have nothing
   in `~/Library/Logs/Klaudio Panels/klaudio.log` to triage from.

The fix for (1) and (2) is the same: a third link provider for
scheme-less domains, registered before the file-link provider so the
position-lookup gives it priority. The fix for (3) is one-liner
diagnostics that future-proofs URL-handling regressions.

## What changes

### 1. New `src/lib/xterm-bare-url-links.ts`

Mirrors the shape of `xterm-file-links.ts`: factory returning an
`ILinkProvider`. Matches `(host\.)+tld[:port][/path]` where `tld` is
in a curated allowlist (com|org|net|io|dev|app|ai|co|la|me|sh|xyz
+ common country codes — see file for the full list). Activate
prepends `https://` and delegates to `openUrlInSystemBrowser`.

Allowlist rationale: every TLD added means any file with that
extension is hijacked into the browser. `.html` deliberately stays
out (too common as filename). `.la` is in (Latin America country
code, matches the user's actual context).

### 2. Provider wiring in three terminal views

The order matters. xterm.js resolves multi-provider clicks by
asking each provider in registration order — the first one whose
link covers the cursor position wins.

| Surface | File | Order |
| --- | --- | --- |
| Claude PTY | `src/components/terminal-view.tsx` | WebLinksAddon → **bare-URL (new)** → file-link |
| Shell PTY | `src/components/shell-terminal/shell-terminal-view.tsx` | WebLinksAddon → **bare-URL (new)** |
| Editor PTY (nvim/helix) | `src/components/diff-panel/editor-pty-view.tsx` | WebLinksAddon → **bare-URL (new)** |

The bare-URL provider goes between WebLinksAddon and file-link
on Claude PTY for the position-lookup priority — that's what
takes domains away from the file regex. Shell and editor only have
WebLinks today, so the bare-URL provider is purely additive there.

### 3. `src/lib/open-url.ts` — diagnostic logging

Replace `console.warn` with `debugLog`:

```diff
 import { openUrl } from "@tauri-apps/plugin-opener";
+import { debugLog } from "@/lib/debug-log";

 export function openUrlInSystemBrowser(
   _event: MouseEvent,
   uri: string,
 ): void {
-  void openUrl(uri).catch((err) => console.warn("openUrl failed", uri, err));
+  debugLog("open-url", `attempt ${uri}`);
+  void openUrl(uri).catch((err) => {
+    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
+    debugLog("open-url", `failed ${uri} — ${msg}`);
+  });
 }
```

The `attempt` line is intentional — without it we can't tell whether
the click reached the handler at all vs. the handler reached `openUrl`
but `openUrl` failed silently after returning (e.g. NSWorkspace
returning no-error for an unknown URL handler).

## What does NOT change

- WebLinksAddon stays the primary handler for `https://…` — its
  multi-line wrap handling and trailing-punctuation trimming are
  better than what the bare-URL provider needs to do for sceme-less
  matches.
- The file-link provider is untouched. The fix for the false-positive
  comes from the registration-order change, not from tightening the
  file regex (which would risk false negatives on real file paths).
- `installGlobalErrorForwarding` stays scoped to errors + rejections.
  Forwarding all `console.warn` calls would be noisy (other call sites
  use it for non-actionable warnings); the open-url path uses
  `debugLog` directly instead.

## Risks / trade-offs

- **TLD allowlist drift.** Domains under uncommon TLDs (`.museum`,
  `.engineering`, `.dev` — wait that one's in) won't be linkified.
  Cheap to extend — every collision goes the other way (a real file
  ending in `.la` would lose its file-link match). Conservative on
  purpose; we can grow the list when a real case shows up.
- **Trailing-punctuation trimming.** The regex is liberal about path
  characters and then strips trailing `.,;:!?)]'"\`` post-match. A
  URL legitimately ending in one of those (rare) would be truncated
  by one character. Same trade WebLinksAddon makes.
- **Port ranges.** Matches `:2-5 digits`. Excludes 1-digit "ports"
  (which clash with `:line` in `file.ts:42`) and 6+ (not valid).
  Means `localhost:8080`-style dev URLs work; `foo.ts:42` stays a
  file.

## Verification

1. `bun run typecheck` clean.
2. In `bun tauri dev`:
   - `https://example.com` from Claude — ⌘+click opens system browser
     (existing WebLinksAddon path, unchanged).
   - `app.constructai.la` — hover underlines, ⌘+click opens
     `https://app.constructai.la` in system browser (new).
   - `linear.app/construct-ai/issue/CAI-1292` — same, opens the
     full URL with path (new).
   - `src/lib/open-url.ts:11` — ⌘+click still routes to the diff
     panel (file-link path unchanged).
3. `tail -f ~/Library/Logs/Klaudio Panels/klaudio.log` shows
   `[JS:open-url] attempt …` on every click; any handler failure
   prints `[JS:open-url] failed … — <error>`.

## Out of scope

- Public Suffix List integration (too big for the value).
- Detecting and offering to copy URLs that the regex doesn't match.
- Inline preview cards for clicked URLs.
