// Read-only resolution of a project's *pre-existing* Claude Code `statusLine`
// command, checked across the same local > project > user precedence Claude
// Code itself uses for `.claude/settings*.json`. A later piece of this
// feature (not this module's concern) needs to know the original command so
// it can chain a bridge helper to it from an overlay, rather than clobbering
// whatever the user already configured.
//
// Fails closed, mirroring `project_env.rs`'s direnv philosophy: any tier
// whose settings file can't be conclusively read/parsed, or whose
// `statusLine` value doesn't match the one shape we understand
// (`{"type": "command", "command": "<string>"}`), aborts the whole
// resolution with `Err` rather than guessing `None`. A parsing failure must
// never be silently read as "nothing configured" — the caller's correct
// response to `Err` is to skip installing any statusline overlay for this
// spawn.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::project_env::resolve_claude_config_dir;

/// Resolves the effective pre-existing `statusLine.command` for
/// `project_path`, checking local > project > user precedence. `Ok(None)`
/// means every tier was successfully checked and none configured a
/// statusLine — safe to install an overlay. `Ok(Some(cmd))` is the command
/// to preserve/chain.
///
/// `Err` means some tier could not be conclusively resolved (malformed
/// JSON, unreadable file, unrecognized statusLine shape, or a
/// `CLAUDE_CONFIG_DIR` resolution failure) — callers MUST NOT treat this as
/// "no original statusLine exists". A parsing failure is never silently
/// interpreted as nothing being configured; the caller's correct response
/// to `Err` is to skip installing any overlay entirely for this spawn.
pub fn resolve_effective_statusline(project_path: &str) -> Result<Option<String>, String> {
    let project_root = PathBuf::from(project_path);

    let local_settings = project_root.join(".claude").join("settings.local.json");
    if let Some(command) = statusline_from_tier(&local_settings)? {
        return Ok(Some(command));
    }

    let project_settings = project_root.join(".claude").join("settings.json");
    if let Some(command) = statusline_from_tier(&project_settings)? {
        return Ok(Some(command));
    }

    // Only reached when neither the local nor project tier answered.
    // Resolves the same `CLAUDE_CONFIG_DIR` Claude itself would use for this
    // project (see `project_env.rs`), falling back to the plain `~/.claude`
    // root when the project's direnv (if any) doesn't set one. Propagating
    // `?` here means a direnv evaluation failure aborts this resolution too
    // — the same ambiguity that makes `resolve_claude_config_dir` itself
    // fail closed.
    let user_settings = match resolve_claude_config_dir(project_path)? {
        Some(config_dir) => config_dir.join("settings.json"),
        None => dirs::home_dir()
            .ok_or_else(|| "could not resolve the current user's home directory".to_string())?
            .join(".claude")
            .join("settings.json"),
    };
    statusline_from_tier(&user_settings)
}

/// Reads and checks a single settings file for a `statusLine` command.
///
/// `Ok(None)` covers every "not configured at this tier" case: the file
/// doesn't exist, or it exists but has no `statusLine` key (or an explicit
/// `null`). Everything else that could be genuinely ambiguous — an
/// unreadable or non-UTF8 file, invalid JSON, a non-object top level, or a
/// `statusLine` value that isn't the `{"type": "command", "command": "..."}`
/// shape this function understands — is `Err`, never guessed as `None`.
fn statusline_from_tier(path: &Path) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;

    let parsed: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("{} contains invalid JSON: {e}", path.display()))?;

    let root = parsed.as_object().ok_or_else(|| {
        format!(
            "{} does not have a JSON object at the top level",
            path.display()
        )
    })?;

    match root.get("statusLine") {
        None | Some(Value::Null) => Ok(None),
        Some(status_line) => parse_command_statusline(status_line, path).map(Some),
    }
}

/// Extracts the command from a `statusLine` value already known to be
/// present and non-null, or errors if it isn't the
/// `{"type": "command", "command": "<non-empty string>"}` shape this
/// function understands. `type` may be omitted, but if present it must be
/// exactly `"command"` — any other value means some statusline mechanism we
/// don't recognize is configured, which is ambiguous rather than "none".
fn parse_command_statusline(value: &Value, path: &Path) -> Result<String, String> {
    let obj = value.as_object().ok_or_else(|| {
        format!(
            "{} configures a `statusLine` that isn't the expected object shape",
            path.display()
        )
    })?;

    if let Some(type_value) = obj.get("type") {
        let type_name = type_value.as_str().ok_or_else(|| {
            format!(
                "{} configures a `statusLine.type` that isn't a string",
                path.display()
            )
        })?;
        if type_name != "command" {
            return Err(format!(
                "{} configures a `statusLine` of an unrecognized type {type_name:?}",
                path.display()
            ));
        }
    }

    obj.get("command")
        .and_then(Value::as_str)
        .filter(|command| !command.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "{} configures a command statusLine with no usable `command` string",
                path.display()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A directory under the OS temp dir, removed on drop. Mirrors
    /// `project_env.rs`'s test helper of the same shape — a fake project
    /// root we can freely populate with `.claude/settings*.json` files.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "klaudio-statusline-test-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        /// Writes `contents` to `.claude/<file_name>` under this project
        /// root, creating the `.claude` directory if needed.
        fn write_claude_settings(&self, file_name: &str, contents: &str) {
            let claude_dir = self.0.join(".claude");
            fs::create_dir_all(&claude_dir).unwrap();
            fs::write(claude_dir.join(file_name), contents).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // NOTE: There is deliberately no test for the "all three tiers empty ->
    // Ok(None)" case. Exercising it for real would require either the
    // test-running machine's actual `~/.claude/settings.json` to be empty
    // (an assumption we can't make about any dev or CI machine) or a way to
    // inject the user-tier path, which `resolve_effective_statusline`'s
    // signature intentionally doesn't offer. Every test below instead
    // resolves at the local or project tier, which — per the precedence
    // check below — never reaches the user tier at all.

    #[test]
    fn local_tier_command_is_returned_without_needing_other_tiers() {
        let project = TempDir::new("local-only");
        project.write_claude_settings(
            "settings.local.json",
            r#"{"statusLine": {"type": "command", "command": "echo local"}}"#,
        );

        let result = resolve_effective_statusline(project.path().to_str().unwrap())
            .expect("local-tier command should resolve");
        assert_eq!(result, Some("echo local".to_string()));
    }

    /// Also proves precedence stops at the project tier without ever
    /// reaching the user tier: falling through further would call
    /// `resolve_claude_config_dir`, which spawns the real login shell and
    /// (if direnv is on the real PATH) evaluates this test's project
    /// directory against it — none of which this test sets up, and which
    /// would make the test either fail or hang depending on the machine
    /// it runs on. The project-tier answer must short-circuit first.
    #[test]
    fn project_tier_used_when_local_absent_and_stops_before_user_tier() {
        let project = TempDir::new("project-only");
        project.write_claude_settings(
            "settings.json",
            r#"{"statusLine": {"type": "command", "command": "echo project"}}"#,
        );

        let result = resolve_effective_statusline(project.path().to_str().unwrap())
            .expect("project-tier command should resolve");
        assert_eq!(result, Some("echo project".to_string()));
    }

    #[test]
    fn local_tier_wins_over_project_tier() {
        let project = TempDir::new("local-wins");
        project.write_claude_settings(
            "settings.json",
            r#"{"statusLine": {"type": "command", "command": "echo project"}}"#,
        );
        project.write_claude_settings(
            "settings.local.json",
            r#"{"statusLine": {"type": "command", "command": "echo local"}}"#,
        );

        let result = resolve_effective_statusline(project.path().to_str().unwrap())
            .expect("local-tier command should win over project-tier");
        assert_eq!(result, Some("echo local".to_string()));
    }

    #[test]
    fn local_tier_invalid_json_is_an_error_without_leaking_contents() {
        let project = TempDir::new("local-invalid-json");
        let secret = "TOP_SECRET_SHOULD_NOT_LEAK";
        project.write_claude_settings(
            "settings.local.json",
            &format!("{{ this is not valid json {secret}"),
        );

        let err = resolve_effective_statusline(project.path().to_str().unwrap())
            .expect_err("invalid JSON must fail closed");
        assert!(!err.contains(secret));
    }

    #[test]
    fn local_tier_unrecognized_statusline_type_is_an_error() {
        let project = TempDir::new("local-unrecognized-type");
        project.write_claude_settings(
            "settings.local.json",
            r#"{"statusLine": {"type": "some-future-type"}}"#,
        );

        resolve_effective_statusline(project.path().to_str().unwrap())
            .expect_err("an unrecognized statusLine type must fail closed");
    }

    #[test]
    fn local_tier_statusline_as_plain_string_is_an_error() {
        let project = TempDir::new("local-string-statusline");
        project.write_claude_settings("settings.local.json", r#"{"statusLine": "just-a-string"}"#);

        resolve_effective_statusline(project.path().to_str().unwrap())
            .expect_err("a non-object statusLine value must fail closed");
    }

    #[test]
    fn local_tier_command_type_missing_command_field_is_an_error() {
        let project = TempDir::new("local-missing-command");
        project.write_claude_settings(
            "settings.local.json",
            r#"{"statusLine": {"type": "command"}}"#,
        );

        resolve_effective_statusline(project.path().to_str().unwrap())
            .expect_err("a command statusLine with no command string must fail closed");
    }

    #[test]
    fn local_tier_missing_statusline_key_falls_through_to_project_tier() {
        let project = TempDir::new("local-no-statusline-key");
        project.write_claude_settings("settings.local.json", r#"{"otherSetting": true}"#);
        project.write_claude_settings(
            "settings.json",
            r#"{"statusLine": {"type": "command", "command": "echo project"}}"#,
        );

        let result = resolve_effective_statusline(project.path().to_str().unwrap())
            .expect("absent statusLine key should fall through to project tier");
        assert_eq!(result, Some("echo project".to_string()));
    }

    #[test]
    fn local_tier_null_statusline_falls_through_to_project_tier() {
        let project = TempDir::new("local-null-statusline");
        project.write_claude_settings("settings.local.json", r#"{"statusLine": null}"#);
        project.write_claude_settings(
            "settings.json",
            r#"{"statusLine": {"type": "command", "command": "echo project"}}"#,
        );

        let result = resolve_effective_statusline(project.path().to_str().unwrap())
            .expect("null statusLine should fall through to project tier");
        assert_eq!(result, Some("echo project".to_string()));
    }
}
