// Prepares (but never installs into a live process) the ephemeral
// `--settings` overlay + `KLAUDIO_CONTEXT_FILE` env var that make a spawned
// Claude Code tab pipe its statusLine ticks through
// `klaudio-statusline-bridge` instead of (but chained to, when one exists)
// the user's own real statusLine command.
//
// This module never spawns anything and never touches a live PTY — that's
// `pty.rs`'s job, right before its `spawn_pty(...)` call. Everything here is
// pure preparation: resolve whether an overlay is safe to install at all
// (`statusline_resolve.rs`'s precedence check), write the per-tab
// `BridgeContext` file the bridge binary will read, and hand back the argv
// bits and env var pty.rs should attach to the spawn.
//
// Optional-telemetry philosophy: every failure mode collapses to `Ok(None)`
// — no bridge binary resolvable, no app-data dir, an ambiguous pre-existing
// statusLine, a write/verify failure. Callers must never let any of this
// block the actual Claude launch, and this module never lets a failure here
// propagate as a real error either — see `prepare_status_bar_overlay`'s doc
// comment for the precise reasoning.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

use crate::debug_log;
use crate::statusline_resolve::resolve_effective_statusline;
use crate::usage_snapshot::{profile_hash, BridgeContext};

/// Backstop TTL for `prune_stale_context_files`: generous enough that it
/// only ever catches a context file orphaned by a process that never got to
/// fire `pty:exit` (a force-quit, a crash), never a tab that's merely been
/// open a long time.
pub const DEFAULT_STALE_CONTEXT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

const BRIDGE_CONTEXT_DIR_NAME: &str = "bridge-context";
const SNAPSHOT_DIR_NAME: &str = "status-snapshots";
const BRIDGE_BINARY_NAME: &str = "klaudio-statusline-bridge";

/// Everything pty.rs needs to attach the overlay to one Claude spawn.
pub struct PreparedOverlay {
    /// The full `--settings` JSON value to append to argv (as a single
    /// argument following a separate `--settings` flag).
    pub settings_arg: String,
    /// `("KLAUDIO_CONTEXT_FILE", <absolute path>)` — push onto the child's
    /// env.
    pub env_var: (String, String),
    /// Where the `BridgeContext` was written. Kept around so the caller can
    /// pass it to `pty::register_exit_cleanup` once the tab's `pty:exit`
    /// event fires.
    pub context_file_path: PathBuf,
    /// `<snapshot_dir>/<tab_id>.json` — the file the bridge binary writes
    /// `UsageSnapshot`s to. Also handed to `pty::register_exit_cleanup`.
    pub snapshot_file_path: PathBuf,
}

/// Resolves the `klaudio-statusline-bridge` binary's path. Tries, in order:
///
/// 1. A file named `klaudio-statusline-bridge` next to Klaudio's own
///    running executable — covers `cargo tauri dev` / debug builds, where
///    both binary targets land in the same `target/debug/` directory.
/// 2. Tauri's app resource directory — covers a packaged build, once the
///    bundling config that ships this binary as a resource exists (it
///    doesn't yet as of this writing; that's a separate, later change, and
///    until it lands this candidate simply never resolves in a packaged
///    build, which is expected).
///
/// Returns the first candidate that exists as a regular file, else `None`.
pub fn resolve_bridge_binary_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            let candidate = dir.join(BRIDGE_BINARY_NAME);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join(BRIDGE_BINARY_NAME);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

/// Prepares (but does not install into any live process) everything needed
/// for the status-bar overlay for one tab spawn.
///
/// `Ok(None)` means: for any reason (no bridge binary resolvable, app-data
/// dir unresolvable, or `resolve_effective_statusline` came back ambiguous),
/// no overlay should be installed for this spawn — the caller's correct
/// response is to spawn Claude completely normally, with no `--settings`
/// flag and no `KLAUDIO_CONTEXT_FILE` env var, and no error surfaced to the
/// user.
///
/// This function never returns `Err` for any of those ambiguous-or-missing
/// conditions — they all collapse to `Ok(None)`, each logged with its own
/// distinct message for debugging. The `Result` in the signature is kept
/// for callers that may one day want to distinguish a hard bug from a
/// deliberate skip, but today `pty.rs` treats `Err` and `Ok(None)`
/// identically, and this function never actually produces the former.
pub fn prepare_status_bar_overlay(
    app: &AppHandle,
    project_path: &str,
    profile_id: &str,
    tab_id: &str,
    bridge_binary_path: &Path,
) -> Result<Option<PreparedOverlay>, String> {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => {
            debug_log::write(
                "statusline",
                &format!("skipping overlay for tab {tab_id}: could not resolve app data directory"),
            );
            return Ok(None);
        }
    };

    // Opportunistic crash-recovery backstop — never blocks or fails the
    // main flow below.
    prune_stale_context_files_in(&app_data_dir, DEFAULT_STALE_CONTEXT_TTL);

    Ok(prepare_overlay_with_paths(
        &app_data_dir,
        project_path,
        profile_id,
        tab_id,
        bridge_binary_path,
    ))
}

/// The pure core of `prepare_status_bar_overlay`, taking an already-resolved
/// `app_data_dir` instead of an `AppHandle` so it's testable with plain temp
/// directories — no Tauri app needed.
fn prepare_overlay_with_paths(
    app_data_dir: &Path,
    project_path: &str,
    profile_id: &str,
    tab_id: &str,
    bridge_binary_path: &Path,
) -> Option<PreparedOverlay> {
    let original_command = match resolve_effective_statusline(project_path) {
        Ok(command) => command,
        Err(_) => {
            // Never log `e`'s content — it could echo back fragments of a
            // malformed settings file.
            debug_log::write(
                "statusline",
                &format!(
                    "skipping overlay for tab {tab_id}: could not resolve effective statusLine"
                ),
            );
            return None;
        }
    };

    let hash = profile_hash(profile_id);
    let snapshot_dir = app_data_dir.join(SNAPSHOT_DIR_NAME).join(&hash);

    if !bridge_binary_path.is_file() {
        debug_log::write(
            "statusline",
            &format!("skipping overlay for tab {tab_id}: bridge binary not found on disk"),
        );
        return None;
    }

    let context = BridgeContext {
        provider_id: "claude".to_string(),
        tab_id: tab_id.to_string(),
        snapshot_dir: snapshot_dir.to_string_lossy().to_string(),
        original_command,
    };

    let bridge_context_dir = app_data_dir.join(BRIDGE_CONTEXT_DIR_NAME);
    let context_file_path = bridge_context_dir.join(format!("{tab_id}.json"));

    if let Err(e) = write_context_atomically(&bridge_context_dir, &context_file_path, &context) {
        debug_log::write(
            "statusline",
            &format!("skipping overlay for tab {tab_id}: failed to write bridge context file: {e}"),
        );
        return None;
    }

    if !verify_written_context(&context_file_path, &context) {
        debug_log::write(
            "statusline",
            &format!(
                "skipping overlay for tab {tab_id}: bridge context file failed verification after write"
            ),
        );
        let _ = fs::remove_file(&context_file_path);
        return None;
    }

    let settings_arg = serde_json::json!({
        "statusLine": {
            "type": "command",
            "command": bridge_binary_path.to_string_lossy()
        }
    })
    .to_string();

    Some(PreparedOverlay {
        settings_arg,
        env_var: (
            "KLAUDIO_CONTEXT_FILE".to_string(),
            context_file_path.to_string_lossy().to_string(),
        ),
        context_file_path,
        snapshot_file_path: snapshot_dir.join(format!("{tab_id}.json")),
    })
}

/// Writes `context` as JSON to a temp file inside `dir`, chmods it 0600,
/// then renames it onto `final_path` (same-filesystem rename is atomic on
/// POSIX). `dir` is created first (0700, best-effort — 0600 on the file
/// itself is the hard requirement).
fn write_context_atomically(
    dir: &Path,
    final_path: &Path,
    context: &BridgeContext,
) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let _ = set_owner_only_permissions(dir, 0o700);

    let json = serde_json::to_vec(context)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

    let tmp_name = format!(
        ".{}.tmp-{}",
        final_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("bridge-context.json"),
        std::process::id()
    );
    let tmp_path = dir.join(tmp_name);

    fs::write(&tmp_path, &json)?;
    if let Err(e) = set_owner_only_permissions(&tmp_path, 0o600) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp_path, final_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path, _mode: u32) -> io::Result<()> {
    // Unix file-mode bits don't exist on other platforms; this is a
    // belt-and-suspenders hardening step there, not a hard requirement.
    Ok(())
}

/// Re-reads `path` and confirms it parses as a `BridgeContext` field-for-
/// field equal to `expected`. Any failure along the way (read error, parse
/// error, mismatch) is `false`.
fn verify_written_context(path: &Path, expected: &BridgeContext) -> bool {
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<BridgeContext>(&contents) else {
        return false;
    };
    parsed == *expected
}

/// Lazily prunes bridge-context files older than a generous TTL (crash
/// recovery backstop — normal cleanup goes through
/// `pty::register_exit_cleanup`, this only catches leftovers from a
/// process that never got to fire `pty:exit`, e.g. a force-quit). Call this
/// opportunistically before writing a new context file, not on a timer.
pub fn prune_stale_context_files(app: &AppHandle, ttl: Duration) {
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        prune_stale_context_files_in(&app_data_dir, ttl);
    }
}

/// Pure core of `prune_stale_context_files`, taking `app_data_dir` directly
/// so it's testable without a real Tauri app.
fn prune_stale_context_files_in(app_data_dir: &Path, ttl: Duration) {
    let dir = app_data_dir.join(BRIDGE_CONTEXT_DIR_NAME);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        if age > ttl {
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A directory under the OS temp dir, removed on drop. Mirrors the
    /// helper of the same shape in `project_env.rs` / `statusline_resolve.rs`.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "klaudio-statusline-context-test-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

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

    /// Writes an executable (but never actually executed by this module —
    /// only `.is_file()` is checked) file at `dir/name`, standing in for the
    /// real `klaudio-statusline-bridge` binary in tests.
    fn write_fake_bridge_binary(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    fn file_mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn no_pre_existing_statusline_produces_overlay_with_0600_context_file() {
        let app_data = TempDir::new("app-data");
        let project = TempDir::new("project-empty");
        let bridge_dir = TempDir::new("bridge-bin");
        let bridge_path = write_fake_bridge_binary(bridge_dir.path(), "klaudio-statusline-bridge");

        let overlay = prepare_overlay_with_paths(
            app_data.path(),
            project.path().to_str().unwrap(),
            "default",
            "tab-1",
            &bridge_path,
        )
        .expect("overlay should be prepared when nothing is configured");

        assert!(overlay.context_file_path.is_file());
        assert_eq!(file_mode(&overlay.context_file_path), 0o600);

        let written: BridgeContext =
            serde_json::from_str(&fs::read_to_string(&overlay.context_file_path).unwrap())
                .unwrap();
        assert_eq!(written.original_command, None);
        assert_eq!(written.tab_id, "tab-1");
        assert!(overlay.settings_arg.contains("klaudio-statusline-bridge"));
        assert_eq!(overlay.env_var.0, "KLAUDIO_CONTEXT_FILE");
    }

    #[test]
    fn pre_existing_statusline_is_preserved_as_original_command() {
        let app_data = TempDir::new("app-data-preexisting");
        let project = TempDir::new("project-with-statusline");
        project.write_claude_settings(
            "settings.local.json",
            r#"{"statusLine": {"type": "command", "command": "echo original"}}"#,
        );
        let bridge_dir = TempDir::new("bridge-bin-preexisting");
        let bridge_path = write_fake_bridge_binary(bridge_dir.path(), "klaudio-statusline-bridge");

        let overlay = prepare_overlay_with_paths(
            app_data.path(),
            project.path().to_str().unwrap(),
            "default",
            "tab-2",
            &bridge_path,
        )
        .expect("overlay should still be prepared, chaining the original command");

        let written: BridgeContext =
            serde_json::from_str(&fs::read_to_string(&overlay.context_file_path).unwrap())
                .unwrap();
        assert_eq!(written.original_command.as_deref(), Some("echo original"));
    }

    #[test]
    fn ambiguous_statusline_resolution_skips_overlay_and_leaves_no_context_file() {
        let app_data = TempDir::new("app-data-ambiguous");
        let project = TempDir::new("project-malformed");
        project.write_claude_settings("settings.local.json", "{ not valid json");
        let bridge_dir = TempDir::new("bridge-bin-ambiguous");
        let bridge_path = write_fake_bridge_binary(bridge_dir.path(), "klaudio-statusline-bridge");

        let overlay = prepare_overlay_with_paths(
            app_data.path(),
            project.path().to_str().unwrap(),
            "default",
            "tab-3",
            &bridge_path,
        );

        assert!(overlay.is_none());
        let bridge_context_dir = app_data.path().join(BRIDGE_CONTEXT_DIR_NAME);
        assert!(
            !bridge_context_dir.join("tab-3.json").exists(),
            "no context file must be left behind when resolution is ambiguous"
        );
    }

    #[test]
    fn missing_bridge_binary_skips_overlay_and_writes_no_context_file() {
        let app_data = TempDir::new("app-data-missing-bridge");
        let project = TempDir::new("project-missing-bridge");
        let missing_bridge_path = app_data.path().join("does-not-exist-binary");

        let overlay = prepare_overlay_with_paths(
            app_data.path(),
            project.path().to_str().unwrap(),
            "default",
            "tab-4",
            &missing_bridge_path,
        );

        assert!(overlay.is_none());
        let bridge_context_dir = app_data.path().join(BRIDGE_CONTEXT_DIR_NAME);
        assert!(!bridge_context_dir.join("tab-4.json").exists());
    }

    /// Regression test: preparing a second tab's overlay under a different
    /// profile must never mutate a different, already-written tab's context
    /// file. This is what would go wrong if a project's direnv changed
    /// profile between two spawns and snapshot namespacing were keyed on
    /// anything other than each tab's own id.
    #[test]
    fn a_second_tabs_overlay_under_a_different_profile_never_touches_the_first_tabs_file() {
        let app_data = TempDir::new("app-data-two-tabs");
        let project = TempDir::new("project-two-tabs");
        let bridge_dir = TempDir::new("bridge-bin-two-tabs");
        let bridge_path = write_fake_bridge_binary(bridge_dir.path(), "klaudio-statusline-bridge");

        let overlay_a = prepare_overlay_with_paths(
            app_data.path(),
            project.path().to_str().unwrap(),
            "profile-a",
            "tab-a",
            &bridge_path,
        )
        .expect("first overlay should be prepared");

        let expected_hash_a = profile_hash("profile-a");
        assert!(overlay_a
            .snapshot_file_path
            .to_string_lossy()
            .contains(&expected_hash_a));

        let bytes_after_first =
            fs::read(&overlay_a.context_file_path).expect("first context file exists");

        // Simulate the project's direnv resolving a different profile for a
        // second, unrelated tab.
        let _overlay_b = prepare_overlay_with_paths(
            app_data.path(),
            project.path().to_str().unwrap(),
            "profile-b",
            "tab-b",
            &bridge_path,
        )
        .expect("second overlay should be prepared");

        let bytes_after_second =
            fs::read(&overlay_a.context_file_path).expect("first context file still exists");
        assert_eq!(
            bytes_after_first, bytes_after_second,
            "an existing tab's context file must never change because a different \
             spawn resolved a different profile"
        );
    }

    #[test]
    fn prune_stale_context_files_removes_only_files_older_than_ttl() {
        let app_data = TempDir::new("app-data-prune");
        let bridge_context_dir = app_data.path().join(BRIDGE_CONTEXT_DIR_NAME);
        fs::create_dir_all(&bridge_context_dir).unwrap();

        let fresh = bridge_context_dir.join("fresh.json");
        let stale = bridge_context_dir.join("stale.json");
        fs::write(&fresh, b"{}").unwrap();
        fs::write(&stale, b"{}").unwrap();

        let ttl = Duration::from_millis(50);
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        let file = fs::File::open(&stale).unwrap();
        file.set_modified(old_time).unwrap();

        prune_stale_context_files_in(app_data.path(), ttl);

        assert!(fresh.exists(), "fresh file must survive the prune");
        assert!(!stale.exists(), "stale file must be removed by the prune");
    }
}
