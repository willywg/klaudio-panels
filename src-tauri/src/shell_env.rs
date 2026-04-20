// Port of OpenCode's shell env hydration
// (packages/desktop/src-tauri/src/cli.rs L220-L365).
// Without this, macOS GUI apps spawn `claude` with a stripped PATH and
// tools like node / git / rg / nvm-installed binaries are not found.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SHELL_ENV_TIMEOUT: Duration = Duration::from_secs(5);

pub fn get_user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
}

fn is_nushell(shell: &str) -> bool {
    let name = Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    name == "nu" || name == "nu.exe" || shell.to_ascii_lowercase().ends_with("\\nu.exe")
}

fn parse_shell_env(stdout: &[u8]) -> HashMap<String, String> {
    String::from_utf8_lossy(stdout)
        .split('\0')
        .filter_map(|entry| {
            if entry.is_empty() {
                return None;
            }
            let (k, v) = entry.split_once('=')?;
            if k.is_empty() {
                return None;
            }
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

fn command_output_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> std::io::Result<Option<std::process::Output>> {
    let mut child = cmd.spawn()?;
    let start = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map(Some);
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

enum ShellEnvProbe {
    Loaded(HashMap<String, String>),
    Timeout,
    Unavailable,
}

fn probe_shell_env(shell: &str, mode: &str) -> ShellEnvProbe {
    let mut cmd = Command::new(shell);
    cmd.args([mode, "-c", "env -0"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

    let output = match command_output_with_timeout(cmd, SHELL_ENV_TIMEOUT) {
        Ok(Some(o)) => o,
        Ok(None) => return ShellEnvProbe::Timeout,
        Err(_) => return ShellEnvProbe::Unavailable,
    };

    if !output.status.success() {
        return ShellEnvProbe::Unavailable;
    }

    let env = parse_shell_env(&output.stdout);
    if env.is_empty() {
        return ShellEnvProbe::Unavailable;
    }

    ShellEnvProbe::Loaded(env)
}

pub fn load_shell_env(shell: &str) -> Option<HashMap<String, String>> {
    if is_nushell(shell) {
        return None;
    }
    if let ShellEnvProbe::Loaded(env) = probe_shell_env(shell, "-il") {
        return Some(env);
    }
    if let ShellEnvProbe::Loaded(env) = probe_shell_env(shell, "-l") {
        return Some(env);
    }
    None
}

/// Merge shell env with explicit overrides; overrides win.
pub fn merge_shell_env(
    shell_env: Option<HashMap<String, String>>,
    overrides: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let mut merged = shell_env.unwrap_or_default();
    for (k, v) in overrides {
        merged.insert(k, v);
    }
    merged.into_iter().collect()
}

/// Resolve `binary` against the hydrated login-shell PATH (falling back to
/// the system PATH if the shell probe failed). Returns the first absolute
/// path that exists and is a regular file. macOS GUI apps ship with a
/// stripped launchd PATH so plain `which` misses Homebrew / nvm / asdf —
/// that's the entire reason this helper exists.
pub fn which_in_shell(
    shell_env: Option<&HashMap<String, String>>,
    binary: &str,
) -> Option<String> {
    if binary.contains('/') {
        let p = Path::new(binary);
        if p.is_file() {
            return Some(binary.to_string());
        }
        return None;
    }

    let path = shell_env
        .and_then(|m| m.get("PATH"))
        .cloned()
        .or_else(|| std::env::var("PATH").ok())?;

    for dir in path.split(':').filter(|s| !s.is_empty()) {
        let candidate = Path::new(dir).join(binary);
        if candidate.is_file() {
            return candidate.to_str().map(|s| s.to_string());
        }
    }
    None
}

/// Tauri command: probe whether a CLI binary (by bare name) exists on the
/// hydrated shell PATH. Used by the "Open in" dropdown to detect terminal
/// editors (nvim / helix / vim / micro) that ship no `.app` bundle.
#[tauri::command]
pub fn check_binary_exists(binary: String) -> bool {
    let shell = get_user_shell();
    let shell_env = load_shell_env(&shell);
    which_in_shell(shell_env.as_ref(), &binary).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_null_delimited_pairs() {
        let env = parse_shell_env(b"PATH=/usr/bin\0FOO=bar=baz\0\0");
        assert_eq!(env.get("PATH"), Some(&"/usr/bin".to_string()));
        assert_eq!(env.get("FOO"), Some(&"bar=baz".to_string()));
    }

    #[test]
    fn parse_skips_invalid() {
        let env = parse_shell_env(b"INVALID\0=empty\0OK=1\0");
        assert_eq!(env.len(), 1);
        assert_eq!(env.get("OK"), Some(&"1".to_string()));
    }

    #[test]
    fn merge_overrides_win() {
        let mut base = HashMap::new();
        base.insert("PATH".into(), "/a".into());
        base.insert("HOME".into(), "/h".into());
        let merged: HashMap<_, _> = merge_shell_env(
            Some(base),
            vec![
                ("PATH".into(), "/b".into()),
                ("TERM".into(), "xterm-256color".into()),
            ],
        )
        .into_iter()
        .collect();
        assert_eq!(merged.get("PATH"), Some(&"/b".to_string()));
        assert_eq!(merged.get("HOME"), Some(&"/h".to_string()));
        assert_eq!(merged.get("TERM"), Some(&"xterm-256color".to_string()));
    }

    #[test]
    fn detects_nushell() {
        assert!(is_nushell("nu"));
        assert!(is_nushell("/opt/homebrew/bin/nu"));
        assert!(!is_nushell("/bin/zsh"));
    }
}
