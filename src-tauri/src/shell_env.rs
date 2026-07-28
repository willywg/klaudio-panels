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

pub(crate) fn command_output_with_timeout(
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

/// Variables that must never enter the fallback baseline (see
/// `safe_baseline_env`), pulled out as a pure filter so it's testable
/// without touching the real process env: `CLAUDE_CONFIG_DIR` must only
/// ever enter a spawned child's env via a project's own direnv diff (see
/// `project_env.rs`) — inheriting whatever Klaudio's own process happened
/// to carry would silently break per-project profile isolation the moment
/// shell hydration fails, which is exactly the case this fallback exists
/// for.
fn strip_unsafe_baseline_vars(
    env: impl Iterator<Item = (String, String)>,
) -> HashMap<String, String> {
    env.filter(|(k, _)| k != "CLAUDE_CONFIG_DIR").collect()
}

/// A degraded-but-safe substitute for a failed shell-env probe: Klaudio's
/// own process env (still a real `PATH`/`HOME` — a macOS GUI app gets *a*
/// PATH from launchd, just not the shell-hydrated one) with the variables
/// `strip_unsafe_baseline_vars` excludes removed. An empty env is not a
/// safe fallback: the child would spawn with no `PATH` and no `HOME` at
/// all (non-negotiable #3).
fn safe_baseline_env() -> HashMap<String, String> {
    strip_unsafe_baseline_vars(std::env::vars())
}

/// Resolves the login-shell-hydrated env, always returning *something*
/// usable — never an env a caller could mistake for "safe to spawn with"
/// when it isn't. The two probe attempts (`-il`, then `-l`) are the actual
/// hydration; nushell (no POSIX-style env dump) and either attempt failing
/// or timing out all fall back to `safe_baseline_env` rather than `None`,
/// so every caller (`merge_shell_env`, `project_env::resolve_project_env`)
/// inherits the guarantee instead of each having to remember to handle a
/// missing env itself.
pub fn load_shell_env(shell: &str) -> Option<HashMap<String, String>> {
    if is_nushell(shell) {
        crate::debug_log::write("shell_env", "nushell detected, using safe baseline env");
        return Some(safe_baseline_env());
    }
    if let ShellEnvProbe::Loaded(env) = probe_shell_env(shell, "-il") {
        return Some(env);
    }
    if let ShellEnvProbe::Loaded(env) = probe_shell_env(shell, "-l") {
        return Some(env);
    }
    crate::debug_log::write(
        "shell_env",
        &format!("shell probe failed for {shell}, using safe baseline env"),
    );
    Some(safe_baseline_env())
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

    #[test]
    fn baseline_fallback_strips_claude_config_dir_but_keeps_everything_else() {
        let synthetic_env = vec![
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("HOME".to_string(), "/home/someone".to_string()),
            (
                "CLAUDE_CONFIG_DIR".to_string(),
                "/some/other/projects/leaked/config".to_string(),
            ),
        ];

        let stripped = strip_unsafe_baseline_vars(synthetic_env.into_iter());

        assert_eq!(stripped.get("PATH"), Some(&"/usr/bin:/bin".to_string()));
        assert_eq!(stripped.get("HOME"), Some(&"/home/someone".to_string()));
        assert!(
            !stripped.contains_key("CLAUDE_CONFIG_DIR"),
            "CLAUDE_CONFIG_DIR must never leak into the fallback baseline — it must only ever \
             come from a project's own resolved direnv diff"
        );
    }

    /// `load_shell_env` must never return `None` — a nushell user (no
    /// POSIX-style `env -0` dump) is exactly the documented, reachable case
    /// where the real hydration can't run at all, and the fallback baseline
    /// must still carry a real PATH/HOME rather than leaving spawn_pty with
    /// nothing to install (see pty.rs's `spawn_pty`, which clears the
    /// child's env unconditionally and installs only what this returns).
    #[test]
    fn nushell_falls_back_to_a_real_baseline_env_not_none() {
        let env = load_shell_env("nu").expect("must fall back to Some, never None");
        assert!(
            env.contains_key("PATH"),
            "fallback baseline must retain PATH so the child (and its Bash tool) can find binaries"
        );
        assert!(
            env.contains_key("HOME"),
            "fallback baseline must retain HOME so the child can find ~/.claude"
        );
        assert!(
            !env.contains_key("CLAUDE_CONFIG_DIR"),
            "the fallback baseline must never carry CLAUDE_CONFIG_DIR"
        );
    }

    /// Same as the nushell case, but through the "probe failed" path
    /// instead of the "recognized as nushell" one — a nonexistent shell
    /// binary reliably fails `command_output_with_timeout`'s `spawn()`.
    #[test]
    fn unavailable_shell_falls_back_to_a_real_baseline_env_not_none() {
        let env = load_shell_env("/nonexistent/definitely-not-a-real-shell-binary")
            .expect("must fall back to Some, never None");
        assert!(env.contains_key("PATH"));
        assert!(env.contains_key("HOME"));
    }

    /// Mirrors exactly what `pty_open_shell`/`pty_open_editor` do to build
    /// the env `spawn_pty` installs (`merge_shell_env(load_shell_env(shell),
    /// overrides)`) for a shell that can't be hydrated. Proves the shell
    /// dock and embedded-editor PTYs still get a real, spawnable env —
    /// `PATH`/`HOME` present — under the fallback, rather than only the
    /// override keys (`TERM`/`COLORTERM`/...) `spawn_pty`'s unconditional
    /// `env_clear()` would otherwise leave a nushell/failed-probe child
    /// with.
    #[test]
    fn shell_and_editor_ptys_still_get_a_spawnable_env_under_the_fallback() {
        let shell_env = load_shell_env("nu");
        let env: HashMap<_, _> = merge_shell_env(
            shell_env,
            vec![
                ("TERM".into(), "xterm-256color".into()),
                ("COLORTERM".into(), "truecolor".into()),
                ("KLAUDIO_SHELL".into(), "1".into()),
            ],
        )
        .into_iter()
        .collect();

        assert!(
            env.contains_key("PATH"),
            "shell/editor PTY env must have PATH"
        );
        assert!(
            env.contains_key("HOME"),
            "shell/editor PTY env must have HOME"
        );
        assert_eq!(env.get("TERM"), Some(&"xterm-256color".to_string()));
    }
}
