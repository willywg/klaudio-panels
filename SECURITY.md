# Security Policy

## Reporting a vulnerability

If you think you've found a security issue in Klaudio Panels, email
**willywg@gmail.com** with the details — 
**please don't open a public issue**. I aim to acknowledge
reports within 72 hours and to coordinate a fix + disclosure timeline
with you.

Please include:

- A minimal reproduction (commands, URLs, files — whatever applies).
- The `Klaudio Panels` version (macOS menu → About).
- Your OS + version (`sw_vers` on macOS).
- Any relevant log excerpt from `~/Library/Logs/Klaudio Panels/klaudio.log`.

## Likely surfaces

Klaudio Panels is a thin shell that embeds the `claude` CLI in a PTY
and reads project files. The most relevant attack surfaces are:

- **Path traversal** in the file tree, the `klaudio://` deep-link
  handler, or `open_path_with` — anything that takes a user-supplied
  path and acts on it.
- **The `klaudio://` URL scheme.** It accepts an absolute path and
  opens it as a project. Malicious websites could fire this URL; the
  current worst case is the user sees an unexpected project in a fresh
  Claude tab (no writes, no code execution on the path itself). If you
  find a way to escalate past that, please report it.
- **Bytes piped through the PTY.** We explicitly don't parse PTY
  output, but anything we do consume (URLs via the WebLinksAddon, file
  paths via cmd-click) should resist injection.
- **Shell install target**: the `klaudio` wrapper script is symlinked
  into `/usr/local/bin` or `~/.local/bin`. If the bundled script can
  be swapped at runtime to escalate, that's a bug.

## Scope

In scope:

- The Klaudio Panels Tauri app (Rust + SolidJS).
- The bundled `klaudio` shell wrapper (`src-tauri/scripts/klaudio`).
- Our custom IPC commands (`pty_*`, `fs::*`, `git::*`, `open_in::*`,
  `shell_install::*`, `cli_args::*`).

Out of scope (please report to the respective upstreams):

- The `claude` CLI itself — report to Anthropic.
- xterm.js, Tauri core, `portable-pty`, `notify`, `git2`, etc. — their
  own security trackers.
- Third-party editors invoked via "Open in".
- Your shell's behavior after running `klaudio`.

## What we won't treat as a security bug

- Gatekeeper warnings from running an unsigned `.app`. That's a
  code-signing gap we track separately (see the sprint plans); you can
  bypass it with `xattr -cr "/Applications/Klaudio Panels.app"`.
- Bugs that require an attacker to already have write access to your
  home directory.
