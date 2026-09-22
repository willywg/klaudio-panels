use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::agent::{self, AgentId};

/// Discover an agent's CLI binary. Strategy (first match wins):
///   0. The path the user configured for this agent, if there is one. It is
///      not a candidate among others: when it is set and does not work, that
///      is an error the user can fix, and quietly falling through to
///      discovery would run a *different* binary than the one they named.
///   1. The agent's own installer paths (`agent::installer_candidates`).
///      These are preferred over everything else because they ship the latest
///      official build — users often have older copies lingering in Homebrew
///      / bun-global / nvm from earlier install methods, and `which` would
///      pick those up first if `/opt/homebrew/bin` comes before
///      `~/.local/bin` in PATH.
///   2. Hydrated login-shell PATH via `which_in_shell` (critical for
///      Finder-launched GUI apps — macOS strips the launchd PATH so
///      `~/.nvm/versions/...` etc. aren't visible otherwise).
///   3. `which` crate against the process PATH (dev runs from terminal).
///   4. The agent's remaining fallbacks (`agent::fallback_candidates`):
///      package managers and version-manager shims.
///
/// Returns the first candidate that responds to `--version` within 2s *and*
/// whose answer identifies it as this agent (`agent::accepts_version`).
pub fn find_agent_binary(id: AgentId) -> Result<PathBuf, String> {
    let spec = agent::spec(id);

    if let Some(configured) = crate::agent_settings::load(id).override_path() {
        if validate(id, &configured) {
            crate::debug_log::write(
                "binary",
                &format!("{} resolved to configured {}", spec.bin_name, configured.display()),
            );
            return Ok(configured);
        }
        let err = format!(
            "The {} binary configured in the agent settings ({}) could not be run. \
             Fix the path, or clear it to search for {} again.",
            spec.display_name,
            configured.display(),
            spec.bin_name,
        );
        crate::debug_log::write("binary", &err);
        return Err(err);
    }

    discover(id)
}

/// Steps 1–4 alone, ignoring any configured path. This is what the settings
/// panel shows as the placeholder of an empty binary field — "leave this
/// blank and this is what runs".
pub fn discover(id: AgentId) -> Result<PathBuf, String> {
    let spec = agent::spec(id);

    // 1. The installer paths first, and on their own: when one of them is
    // the answer — the common case — there is no reason to pay for the
    // login-shell probe behind step 2 (~0.3 s) on every spawn.
    for candidate in agent::installer_candidates(id) {
        if candidate.exists() && validate(id, &candidate) {
            crate::debug_log::write(
                "binary",
                &format!("{} resolved to {}", spec.bin_name, candidate.display()),
            );
            return Ok(candidate);
        }
    }

    let candidates = candidates(id);
    crate::debug_log::write(
        "binary",
        &format!(
            "{} candidates ({}): {candidates:?}",
            spec.bin_name,
            candidates.len()
        ),
    );
    for candidate in candidates {
        if validate(id, &candidate) {
            crate::debug_log::write(
                "binary",
                &format!("{} resolved to {}", spec.bin_name, candidate.display()),
            );
            return Ok(candidate);
        }
    }
    crate::debug_log::write("binary", spec.not_found);
    Err(spec.not_found.to_string())
}

fn candidates(id: AgentId) -> Vec<PathBuf> {
    let spec = agent::spec(id);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let push = |p: PathBuf, acc: &mut Vec<PathBuf>, seen: &mut std::collections::HashSet<PathBuf>| {
        if p.exists() && seen.insert(p.clone()) {
            acc.push(p);
        }
    };

    // Step 1 (installer paths) already ran in `discover` and failed.

    // 2. Hydrated login-shell PATH. Finder-launched apps inherit the
    // launchd PATH which misses Homebrew, nvm, asdf, bun, volta.
    // `which_in_shell` re-runs the user's login shell to capture the real
    // PATH.
    let shell = crate::shell_env::get_user_shell();
    let shell_env = crate::shell_env::load_shell_env(&shell);
    if let Some(resolved) = crate::shell_env::which_in_shell(shell_env.as_ref(), spec.bin_name) {
        push(PathBuf::from(resolved), &mut out, &mut seen);
    }

    // 3. which crate (searches process PATH; covers dev runs)
    if let Ok(p) = which::which(spec.bin_name) {
        push(p, &mut out, &mut seen);
    }

    // 4. Package managers and version-manager shims.
    for p in agent::fallback_candidates(id) {
        push(p, &mut out, &mut seen);
    }

    out
}

/// Runs `--version` and asks the registry whether the answer is this agent.
/// "It ran" is not enough: `agent` is a name any CLI can take, and a path
/// pasted into the settings can be the Cursor IDE's `cursor` shim, which
/// runs fine and opens a GUI editor.
pub fn validate(id: AgentId, path: &Path) -> bool {
    let fingerprint = fingerprint(path);
    if let Some(fp) = &fingerprint {
        if let Ok(cache) = VALIDATED.lock() {
            if cache.get(&(id.as_str(), path.to_path_buf())) == Some(fp) {
                return true;
            }
        }
    }
    let ok = probe_version(id, path);
    if ok {
        if let (Some(fp), Ok(mut cache)) = (fingerprint, VALIDATED.lock()) {
            cache.insert((id.as_str(), path.to_path_buf()), fp);
        }
    }
    ok
}

/// What a validated binary *was*: the file its path resolves to, and that
/// file's size and mtime. Updating an agent swaps the symlink's target or
/// rewrites the file, and either changes this, so a cached "yes" can never
/// outlive the binary it was about.
type Fingerprint = (PathBuf, u64, Option<std::time::SystemTime>);

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let real = path.canonicalize().ok()?;
    let meta = std::fs::metadata(&real).ok()?;
    Some((real, meta.len(), meta.modified().ok()))
}

/// Candidates that have already answered `--version` as their agent. Every
/// spawn used to re-run that probe — twice for a new Cursor tab, and
/// `cursor-agent` is a node program that takes ~0.45 s to answer. Only
/// successes are remembered: a binary that failed may be fixed a moment
/// later, and a stale "no" would outlive the fix.
static VALIDATED: LazyLock<Mutex<HashMap<(&'static str, PathBuf), Fingerprint>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn probe_version(id: AgentId, path: &Path) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    let Ok(mut child) = Command::new(path)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return false;
                }
                // A version line is a few dozen bytes; it cannot fill the
                // pipe and stall the child before it exits.
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut out);
                }
                return agent::accepts_version(id, &out);
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
}
