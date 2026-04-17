use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

/// Discover the `claude` CLI binary. Strategy:
///   1. `which claude` (handles shell PATH).
///   2. Static fallbacks (Homebrew, ~/.local/bin, ~/.claude/local, /usr/local/bin).
///   3. nvm-installed node bins under ~/.nvm/versions/node/*/bin/claude.
///
/// Returns the first candidate that responds to `claude --version` within 2s.
pub fn find_claude_binary() -> Result<PathBuf, String> {
    for candidate in candidates() {
        if validate(&candidate) {
            return Ok(candidate);
        }
    }
    Err(
        "Claude Code CLI not found. Install with `npm i -g @anthropic-ai/claude-code` \
         or ensure `claude` is in PATH."
            .into(),
    )
}

fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let push = |p: PathBuf, acc: &mut Vec<PathBuf>, seen: &mut std::collections::HashSet<PathBuf>| {
        if p.exists() && seen.insert(p.clone()) {
            acc.push(p);
        }
    };

    // 1. which crate (searches PATH; handles most cases)
    if let Ok(p) = which::which("claude") {
        push(p, &mut out, &mut seen);
    }

    // 2. Static fallbacks
    let home = dirs::home_dir();
    let mut statics: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/usr/bin/claude"),
    ];
    if let Some(h) = &home {
        statics.extend([
            h.join(".claude/local/claude"),
            h.join(".local/bin/claude"),
            h.join(".bun/bin/claude"),
            h.join(".volta/bin/claude"),
            h.join(".asdf/shims/claude"),
        ]);
    }
    for p in statics {
        push(p, &mut out, &mut seen);
    }

    // 3. nvm-installed node versions
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
