// Project-scoped environment resolution via `direnv export json`.
//
// Klaudio spawns `claude` with the user's hydrated login-shell env (see
// `shell_env.rs`), but that alone doesn't pick up a project-local `.envrc`
// (e.g. `export CLAUDE_CONFIG_DIR=...` to run a project under a different
// Claude account). This module shells out to `direnv export json` — the
// same mechanism `direnv` uses to hook `cd` in an interactive shell — with
// the project path as cwd, and merges the returned diff on top of the
// hydrated env before Claude is spawned.
//
// Fails closed: if `direnv` is on PATH but evaluating a project errors, we
// return `Err` rather than silently falling back to the default profile —
// see `resolve_project_env`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;

use crate::debug_log;
use crate::shell_env::{command_output_with_timeout, which_in_shell};

const DIRENV_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolve the full child-process environment for `project_path`: the
/// hydrated login-shell env (`shell_env`), then a `direnv export json` diff
/// for the project directory (if `direnv` is on PATH), then `overrides`
/// last.
///
/// Fails closed: if `direnv` is on PATH but evaluating `project_path`
/// errors — blocked `.envrc`, non-zero exit, malformed JSON, timeout, or an
/// empty `CLAUDE_CONFIG_DIR` — this returns `Err` rather than silently
/// launching Claude under the wrong profile. Projects with no `direnv`
/// installed at all, or no `.envrc`, are unaffected and get the plain
/// hydrated env.
pub fn resolve_project_env(
    project_path: &str,
    shell_env: Option<HashMap<String, String>>,
    overrides: Vec<(String, String)>,
) -> Result<Vec<(String, String)>, String> {
    let mut env = shell_env.unwrap_or_default();

    if let Some(direnv_bin) = which_in_shell(Some(&env), "direnv") {
        if let Some(diff) = run_direnv_export(&direnv_bin, project_path, &env)? {
            let changed = apply_direnv_diff(&mut env, &diff)?;
            debug_log::write(
                "direnv",
                &format!("applied diff project={project_path} changed={changed}"),
            );
        }
    }

    normalize_claude_config_dir(&mut env, project_path)?;

    for (k, v) in overrides {
        env.insert(k, v);
    }

    Ok(env.into_iter().collect())
}

/// Resolve just `CLAUDE_CONFIG_DIR` for `project_path`, if direnv (or the
/// login shell itself) sets one. Used by `sessions.rs` to read from
/// `<config-dir>/projects` instead of always `~/.claude/projects`. Fails
/// closed like `resolve_project_env` — see its docs.
pub fn resolve_claude_config_dir(project_path: &str) -> Result<Option<PathBuf>, String> {
    let shell = crate::shell_env::get_user_shell();
    let shell_env = crate::shell_env::load_shell_env(&shell);
    let env = resolve_project_env(project_path, shell_env, Vec::new())?;
    Ok(env
        .into_iter()
        .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .map(|(_, v)| PathBuf::from(v)))
}

/// Derives a stable, opaque namespace for a resolved `CLAUDE_CONFIG_DIR`:
/// `"default"` when there is none, or when it's equivalent to the normal
/// `~/.claude` root; otherwise `"custom:" + base64(path)`.
///
/// The encoded identity always uses `dir` exactly as given (already an
/// absolute path — see `normalize_claude_config_dir`), never a
/// canonicalized form. Canonicalization is used *only* to decide the
/// default-equivalence question below — if the encoding itself used the
/// canonicalized path, the id could silently change over time as a
/// `CLAUDE_CONFIG_DIR` target transitioned from "doesn't exist yet" to
/// "exists" (or a symlink's target changed), fragmenting anything keyed on
/// the id (e.g. localStorage) across otherwise-identical resolutions.
///
/// This is a *stable opaque identifier*, not a formally collision-free one:
/// `Path::to_string_lossy` substitutes U+FFFD for non-UTF-8 byte sequences,
/// so two distinct non-UTF-8 paths could in principle encode identically.
/// Every path direnv/the shell can plausibly produce is valid UTF-8 in
/// practice.
pub fn profile_id_for_config_dir(config_dir: Option<&Path>) -> String {
    let Some(dir) = config_dir else {
        return "default".to_string();
    };
    if is_default_claude_root(dir) {
        return "default".to_string();
    }
    let encoded = URL_SAFE_NO_PAD.encode(dir.to_string_lossy().as_bytes());
    format!("custom:{encoded}")
}

/// True when `dir` refers to the same location as `~/.claude`, resolved
/// through symlinks on both sides for the comparison only (see
/// `profile_id_for_config_dir`'s docs on why this never affects the
/// encoded identity itself).
fn is_default_claude_root(dir: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let default_root = home.join(".claude");
    let resolve = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    resolve(dir) == resolve(&default_root)
}

/// Tauri command: resolve the profile namespace a project's Claude sessions
/// currently belong to. Frontend entry point for `profile_id_for_config_dir`
/// when no env has already been resolved for this project (contrast with
/// `pty_open`, which derives it from the env it already resolved for the
/// spawn instead of evaluating direnv a second time).
#[tauri::command]
pub fn resolve_profile_id(project_path: String) -> Result<String, String> {
    let config_dir = resolve_claude_config_dir(&project_path)?;
    Ok(profile_id_for_config_dir(config_dir.as_deref()))
}

/// Runs `direnv export json` with `project_path` as cwd. `Ok(None)` means
/// direnv had nothing to change (no `.envrc`, or the env is already up to
/// date). The subprocess env is built from scratch (`env_clear` + the
/// hydrated login-shell env) rather than inherited from Klaudio's own
/// process, so direnv evaluates the project the same way it would from an
/// interactive shell — not with whatever ambient env Klaudio happens to
/// carry.
///
/// Never logs or returns direnv's stderr: it can echo back fragments of the
/// `.envrc` (and transitively, secrets it references). Only the project
/// path, exit/timeout status, and changed-variable count are logged.
fn run_direnv_export(
    direnv_bin: &str,
    project_path: &str,
    hydrated_env: &HashMap<String, String>,
) -> Result<Option<Value>, String> {
    let mut cmd = Command::new(direnv_bin);
    cmd.args(["export", "json"]);
    cmd.current_dir(project_path);
    cmd.env_clear();
    cmd.envs(hydrated_env);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = command_output_with_timeout(cmd, DIRENV_TIMEOUT)
        .map_err(|e| format!("failed to run direnv for {project_path}: {e}"))?;

    let output = match output {
        Some(o) => o,
        None => {
            debug_log::write("direnv", &format!("export timed out project={project_path}"));
            return Err(format!(
                "direnv timed out evaluating {project_path}. Run `direnv status` in that \
                 directory to check for a hanging hook, then retry."
            ));
        }
    };

    if !output.status.success() {
        debug_log::write(
            "direnv",
            &format!(
                "export failed project={project_path} exit={:?}",
                output.status.code()
            ),
        );
        return Err(format!(
            "direnv failed to evaluate {project_path} (exit {:?}). Run `direnv status` or \
             `direnv allow` in that directory, then retry.",
            output.status.code()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(None);
    }

    let value: Value = serde_json::from_str(trimmed).map_err(|e| {
        format!("direnv export json: invalid JSON output for {project_path}: {e}")
    })?;
    Ok(Some(value))
}

/// Applies a parsed `direnv export json` diff on top of `base`, returning
/// the number of variables changed. String entries add/overwrite the
/// variable; `null` entries (direnv's way of saying "this var went back to
/// its pre-direnv value, i.e. unset") remove it.
fn apply_direnv_diff(base: &mut HashMap<String, String>, diff: &Value) -> Result<usize, String> {
    let obj = diff
        .as_object()
        .ok_or_else(|| "direnv export json: expected a JSON object at the top level".to_string())?;

    let mut changed = 0usize;
    for (key, value) in obj {
        match value {
            Value::Null => {
                base.remove(key);
            }
            Value::String(s) => {
                base.insert(key.clone(), s.clone());
            }
            other => {
                let kind = match other {
                    Value::Bool(_) => "bool",
                    Value::Number(_) => "number",
                    Value::Array(_) => "array",
                    Value::Object(_) => "object",
                    _ => "unknown",
                };
                return Err(format!(
                    "direnv export json: unexpected {kind} value for variable {key}"
                ));
            }
        }
        changed += 1;
    }
    Ok(changed)
}

/// Make `CLAUDE_CONFIG_DIR` unambiguous before it's used to spawn Claude or
/// to locate `<config-dir>/projects` for the sidebar: reject an empty value
/// outright (fail closed rather than silently falling back to the default
/// `~/.claude` profile), and resolve a relative value against
/// `project_path` — direnv exports the raw string from the `.envrc`
/// verbatim, and neither Claude's child process nor Klaudio itself
/// necessarily has `project_path` as its cwd by the time this is read.
fn normalize_claude_config_dir(
    env: &mut HashMap<String, String>,
    project_path: &str,
) -> Result<(), String> {
    let Some(raw) = env.get("CLAUDE_CONFIG_DIR") else {
        return Ok(());
    };
    if raw.is_empty() {
        return Err(format!(
            "CLAUDE_CONFIG_DIR resolved to an empty value for {project_path}; fix the \
             project's .envrc"
        ));
    }
    let path = PathBuf::from(raw);
    let resolved = if path.is_absolute() {
        path
    } else {
        PathBuf::from(project_path).join(path)
    };
    env.insert(
        "CLAUDE_CONFIG_DIR".to_string(),
        resolved.to_string_lossy().into_owned(),
    );
    Ok(())
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A directory under the OS temp dir, removed on drop. Used both as a
    /// fake PATH entry (holding a fake `direnv` executable) and as a fake
    /// project directory (`direnv export json` needs an existing cwd).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "klaudio-direnv-test-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Writes a fake `direnv` executable into `bin_dir`. Its behavior is
    /// controlled entirely through env vars (`FAKE_DIRENV_STDOUT`,
    /// `FAKE_DIRENV_STDERR`, `FAKE_DIRENV_EXIT`) so a single script covers
    /// every test scenario.
    fn write_fake_direnv(bin_dir: &Path) {
        let script = "#!/bin/sh\n\
             if [ -n \"$FAKE_DIRENV_STDERR\" ]; then printf '%s' \"$FAKE_DIRENV_STDERR\" >&2; fi\n\
             if [ -n \"$FAKE_DIRENV_STDOUT\" ]; then printf '%s' \"$FAKE_DIRENV_STDOUT\"; fi\n\
             exit \"${FAKE_DIRENV_EXIT:-0}\"\n";
        let path = bin_dir.join("direnv");
        fs::write(&path, script).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
    }

    /// Hermetic base env: PATH points only at `bin_dir` (no real system
    /// dirs), so whether `direnv` is "found" is entirely up to whether the
    /// test put a fake one there — independent of what's actually
    /// installed on the machine running the tests.
    fn base_env(bin_dir: &Path) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("PATH".into(), bin_dir.display().to_string());
        env.insert("HOME".into(), "/tmp".into());
        env
    }

    #[test]
    fn project_without_direnv_config_keeps_shell_env() {
        let empty_bin = TempDir::new("no-direnv");
        let project = TempDir::new("project-plain");
        let env = base_env(empty_bin.path());

        let resolved = resolve_project_env(
            project.path().to_str().unwrap(),
            Some(env.clone()),
            vec![("TERM".into(), "xterm-256color".into())],
        )
        .expect("should not fail when direnv is not installed");

        let map: HashMap<_, _> = resolved.into_iter().collect();
        assert_eq!(map.get("PATH"), env.get("PATH"));
        assert_eq!(map.get("TERM"), Some(&"xterm-256color".to_string()));
    }

    #[test]
    fn direnv_present_with_empty_diff_keeps_env_unchanged() {
        let bin = TempDir::new("empty-diff-direnv");
        write_fake_direnv(bin.path());
        let project = TempDir::new("project-no-envrc");

        let mut env = base_env(bin.path());
        env.insert("FAKE_DIRENV_STDOUT".into(), "{}".into());
        env.insert("EXISTING".into(), "keep-me".into());

        let resolved = resolve_project_env(
            project.path().to_str().unwrap(),
            Some(env),
            vec![("OVERRIDE_KEY".into(), "override-value".into())],
        )
        .expect("an empty diff should not error");
        let map: HashMap<_, _> = resolved.into_iter().collect();

        assert_eq!(map.get("EXISTING"), Some(&"keep-me".to_string()));
        assert_eq!(
            map.get("OVERRIDE_KEY"),
            Some(&"override-value".to_string())
        );
    }

    #[test]
    fn project_with_claude_config_dir_merges_diff() {
        let bin = TempDir::new("with-direnv");
        write_fake_direnv(bin.path());
        let project = TempDir::new("project-replace");

        let mut env = base_env(bin.path());
        env.insert(
            "FAKE_DIRENV_STDOUT".into(),
            r#"{"CLAUDE_CONFIG_DIR":"/Users/x/replace/.config/claude","NEW_VAR":"1"}"#.into(),
        );

        let resolved = resolve_project_env(project.path().to_str().unwrap(), Some(env), vec![])
            .expect("direnv export should succeed");
        let map: HashMap<_, _> = resolved.into_iter().collect();

        assert_eq!(
            map.get("CLAUDE_CONFIG_DIR"),
            Some(&"/Users/x/replace/.config/claude".to_string())
        );
        assert_eq!(map.get("NEW_VAR"), Some(&"1".to_string()));
    }

    #[test]
    fn overrides_take_precedence_over_direnv_values() {
        let bin = TempDir::new("override-precedence-direnv");
        write_fake_direnv(bin.path());
        let project = TempDir::new("project-override-precedence");

        let mut env = base_env(bin.path());
        env.insert("FAKE_DIRENV_STDOUT".into(), r#"{"TERM":"dumb"}"#.into());

        let resolved = resolve_project_env(
            project.path().to_str().unwrap(),
            Some(env),
            vec![("TERM".into(), "xterm-256color".into())],
        )
        .expect("direnv export should succeed");
        let map: HashMap<_, _> = resolved.into_iter().collect();

        assert_eq!(map.get("TERM"), Some(&"xterm-256color".to_string()));
    }

    #[test]
    fn relative_claude_config_dir_resolves_against_project_path() {
        let bin = TempDir::new("relative-config-dir-direnv");
        write_fake_direnv(bin.path());
        let project = TempDir::new("project-relative-config");

        let mut env = base_env(bin.path());
        env.insert(
            "FAKE_DIRENV_STDOUT".into(),
            r#"{"CLAUDE_CONFIG_DIR":".config/claude"}"#.into(),
        );

        let resolved = resolve_project_env(project.path().to_str().unwrap(), Some(env), vec![])
            .expect("direnv export should succeed");
        let map: HashMap<_, _> = resolved.into_iter().collect();

        let expected = project.path().join(".config/claude");
        assert_eq!(
            map.get("CLAUDE_CONFIG_DIR"),
            Some(&expected.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn empty_claude_config_dir_is_rejected() {
        let bin = TempDir::new("empty-config-dir-direnv");
        write_fake_direnv(bin.path());
        let project = TempDir::new("project-empty-config");

        let mut env = base_env(bin.path());
        env.insert("FAKE_DIRENV_STDOUT".into(), r#"{"CLAUDE_CONFIG_DIR":""}"#.into());

        let err = resolve_project_env(project.path().to_str().unwrap(), Some(env), vec![])
            .expect_err("an empty CLAUDE_CONFIG_DIR must fail closed");
        assert!(err.contains("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn removed_variable_is_absent_from_final_env() {
        let bin = TempDir::new("remove-var-direnv");
        write_fake_direnv(bin.path());
        let project = TempDir::new("project-remove-var");

        let mut env = base_env(bin.path());
        env.insert("SECRET_TOKEN".into(), "abc123".into());
        env.insert(
            "FAKE_DIRENV_STDOUT".into(),
            r#"{"SECRET_TOKEN":null}"#.into(),
        );

        let resolved = resolve_project_env(project.path().to_str().unwrap(), Some(env), vec![])
            .expect("direnv export should succeed");
        let map: HashMap<_, _> = resolved.into_iter().collect();

        assert!(!map.contains_key("SECRET_TOKEN"));
    }

    #[test]
    fn removed_variables_are_dropped_by_apply_direnv_diff() {
        let mut base = HashMap::new();
        base.insert("KEEP".to_string(), "1".to_string());
        base.insert("GONE".to_string(), "was-set-by-direnv".to_string());

        let diff: Value = serde_json::from_str(r#"{"GONE": null, "ADDED": "yes"}"#).unwrap();
        let changed = apply_direnv_diff(&mut base, &diff).expect("valid diff");

        assert_eq!(changed, 2);
        assert_eq!(base.get("KEEP"), Some(&"1".to_string()));
        assert_eq!(base.get("GONE"), None);
        assert_eq!(base.get("ADDED"), Some(&"yes".to_string()));
    }

    #[test]
    fn direnv_failure_fails_closed_without_leaking_stderr() {
        let bin = TempDir::new("failing-direnv");
        write_fake_direnv(bin.path());
        let project = TempDir::new("project-broken");

        let secret_stderr = "direnv: error .envrc line 3: SUPER_SECRET_TOKEN reference failed";
        let mut env = base_env(bin.path());
        env.insert("FAKE_DIRENV_STDERR".into(), secret_stderr.into());
        env.insert("FAKE_DIRENV_EXIT".into(), "1".into());

        let err = resolve_project_env(project.path().to_str().unwrap(), Some(env), vec![])
            .expect_err("a failing direnv must fail closed, not fall back silently");

        assert!(!err.contains(secret_stderr));
        assert!(!err.contains("SUPER_SECRET_TOKEN"));
        let lower = err.to_lowercase();
        assert!(lower.contains("direnv status") || lower.contains("direnv allow"));
    }

    #[test]
    fn profile_id_for_none_is_default() {
        assert_eq!(profile_id_for_config_dir(None), "default");
    }

    #[test]
    fn profile_id_for_real_claude_root_is_default() {
        let home = dirs::home_dir().expect("home dir must resolve in test env");
        let default_root = home.join(".claude");
        assert_eq!(profile_id_for_config_dir(Some(&default_root)), "default");
    }

    #[test]
    fn profile_id_for_distinct_custom_dirs_differs() {
        let a = TempDir::new("profile-id-a");
        let b = TempDir::new("profile-id-b");
        let id_a = profile_id_for_config_dir(Some(a.path()));
        let id_b = profile_id_for_config_dir(Some(b.path()));
        assert_ne!(id_a, id_b);
        assert!(id_a.starts_with("custom:"));
        assert!(id_b.starts_with("custom:"));
    }

    #[test]
    fn profile_id_decodes_back_to_the_given_path() {
        let dir = TempDir::new("profile-id-roundtrip");
        let id = profile_id_for_config_dir(Some(dir.path()));
        let encoded = id.strip_prefix("custom:").expect("custom prefix");
        let decoded = URL_SAFE_NO_PAD.decode(encoded).expect("valid base64");
        assert_eq!(decoded, dir.path().to_string_lossy().as_bytes());
    }

    /// The id must not depend on whether the directory exists on disk yet —
    /// otherwise the same `.envrc`-declared CLAUDE_CONFIG_DIR would silently
    /// change identity the moment Claude (or the user) creates it, orphaning
    /// anything keyed on the earlier id.
    #[test]
    fn profile_id_is_stable_across_directory_creation() {
        let parent = TempDir::new("profile-id-stability-parent");
        let not_yet_created = parent.path().join("config-root");
        assert!(!not_yet_created.exists());

        let id_before = profile_id_for_config_dir(Some(&not_yet_created));

        fs::create_dir_all(&not_yet_created).unwrap();
        assert!(not_yet_created.exists());

        let id_after = profile_id_for_config_dir(Some(&not_yet_created));

        assert_eq!(id_before, id_after);
    }

    #[test]
    fn resolve_profile_id_end_to_end_via_fake_direnv() {
        let bin = TempDir::new("resolve-profile-id-direnv");
        write_fake_direnv(bin.path());
        let project = TempDir::new("project-resolve-profile-id");
        let custom_root = TempDir::new("resolve-profile-id-custom-root");

        let mut env = base_env(bin.path());
        env.insert(
            "FAKE_DIRENV_STDOUT".into(),
            format!(
                r#"{{"CLAUDE_CONFIG_DIR":"{}"}}"#,
                custom_root.path().display()
            ),
        );

        // Mirrors `resolve_profile_id`'s body without going through
        // `get_user_shell`/`load_shell_env` (a real login-shell spawn), same
        // rationale as every other test in this module.
        let resolved = resolve_project_env(project.path().to_str().unwrap(), Some(env), vec![])
            .expect("direnv export should succeed");
        let config_dir = resolved
            .into_iter()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
            .map(|(_, v)| PathBuf::from(v));

        let profile_id = profile_id_for_config_dir(config_dir.as_deref());
        assert!(profile_id.starts_with("custom:"));
    }
}
