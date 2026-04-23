---
name: Bug report
about: Something in Klaudio Panels isn't working the way you expect
title: ""
labels: bug
---

## What happened

<!-- A short description of the bug. -->

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What did you think should happen? -->

## Screenshots / screen recording

<!-- Optional but very helpful, especially for UI glitches. -->

## Environment

- Klaudio Panels version: <!-- macOS menu → About, or `Klaudio Panels.app/Contents/Info.plist` -->
- macOS version: <!-- `sw_vers -productVersion` -->
- Architecture: <!-- `arch` → arm64 or x86_64 -->
- `claude` version: <!-- `claude --version` -->
- Shell: <!-- `echo $SHELL` -->

## Logs

Klaudio Panels writes a diagnostic log on every run. Please grab the
chunk around when the bug happened and paste it below.

**macOS**

```bash
# Tail the last ~200 lines:
tail -n 200 "$HOME/Library/Logs/Klaudio Panels/klaudio.log"

# Or reveal the file in Finder:
open "$HOME/Library/Logs/Klaudio Panels"
```

**Linux**

```bash
tail -n 200 "$HOME/.klaudio-panels/logs/klaudio.log"
```

<!--
Please redact anything you'd rather not share (project paths, usernames,
tokens, etc.). If the log is large, a Gist link is fine too.
-->

```
<paste logs here>
```

## Anything else

<!-- Related issues, recent changes, weird reproductions, etc. -->
