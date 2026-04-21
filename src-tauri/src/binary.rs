use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

/// Discover the `claude` CLI binary. Strategy (first match wins):
///   1. Anthropic's native installer paths (`~/.local/bin/claude` and
///      `~/.claude/local/claude`). These are preferred over everything
///      else because they ship the latest official build — users often
///      have older copies lingering in Homebrew / bun-global / nvm from
///      earlier install methods, and `which` would pick those up first
///      if `/opt/homebrew/bin` comes before `~/.local/bin` in PATH.
///   2. Hydrated login-shell PATH via `which_in_shell` (critical for
///      Finder-launched GUI apps — macOS strips the launchd PATH so
///      `~/.nvm/versions/...` etc. aren't visible otherwise).
///   3. `which` crate against the process PATH (dev runs from terminal).
///   4. Remaining static fallbacks (~/.bun/bin, ~/.volta, ~/.asdf, …).
///   5. nvm-installed node bins under ~/.nvm/versions/node/*/bin/claude.
///
/// Returns the first candidate that responds to `claude --version` within 2s.
pub fn find_claude_binary() -> Result<PathBuf, String> {
    let candidates = candidates();
    crate::debug_log::write(
        "binary",
        &format!("claude candidates ({}): {candidates:?}", candidates.len()),
    );
    for candidate in candidates {
        if validate(&candidate) {
            crate::debug_log::write(
                "binary",
                &format!("claude resolved to {}", candidate.display()),
            );
            return Ok(candidate);
        }
    }
    let err =
        "Claude Code CLI not found. Install with `npm i -g @anthropic-ai/claude-code` \
         or ensure `claude` is in PATH."
            .to_string();
    crate::debug_log::write("binary", &err);
    Err(err)
}

fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let push = |p: PathBuf, acc: &mut Vec<PathBuf>, seen: &mut std::collections::HashSet<PathBuf>| {
        if p.exists() && seen.insert(p.clone()) {
            acc.push(p);
        }
    };

    let home = dirs::home_dir();

    // 1. Native installer paths — preferred. These are where Anthropic's
    // official installer drops the latest build; we want them to win over
    // any stale Homebrew / bun / npm copy still on PATH.
    if let Some(h) = &home {
        push(h.join(".local/bin/claude"), &mut out, &mut seen);
        push(h.join(".claude/local/claude"), &mut out, &mut seen);
    }

    // 2. Hydrated login-shell PATH. Finder-launched apps inherit the
    // launchd PATH which misses Homebrew, nvm, asdf, bun, volta.
    // `which_in_shell` re-runs the user's login shell to capture the real
    // PATH.
    let shell = crate::shell_env::get_user_shell();
    let shell_env = crate::shell_env::load_shell_env(&shell);
    if let Some(resolved) = crate::shell_env::which_in_shell(shell_env.as_ref(), "claude") {
        push(PathBuf::from(resolved), &mut out, &mut seen);
    }

    // 3. which crate (searches process PATH; covers dev runs)
    if let Ok(p) = which::which("claude") {
        push(p, &mut out, &mut seen);
    }

    // 4. Remaining static fallbacks
    let mut statics: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/usr/bin/claude"),
    ];
    if let Some(h) = &home {
        statics.extend([
            h.join(".bun/bin/claude"),
            h.join(".volta/bin/claude"),
            h.join(".asdf/shims/claude"),
        ]);
    }
    for p in statics {
        push(p, &mut out, &mut seen);
    }

    // 5. nvm-installed node versions
    if let Some(h) = &home {
        let nvm_root = h.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            for entry in entries.flatten() {
                push(entry.path().join("bin/claude"), &mut out, &mut seen);
            }
        }
    }

    out
}

fn validate(path: &PathBuf) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    let Ok(mut child) = Command::new(path)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
}

#[tauri::command]
pub fn get_claude_binary() -> Result<String, String> {
    find_claude_binary().map(|p| p.to_string_lossy().into_owned())
}
