//! Install / uninstall the `klaudio` shell wrapper in the user's PATH. The
//! script itself ships inside the .app bundle at
//! `<Resources>/scripts/klaudio`; we just symlink to it from a PATH-visible
//! location. macOS prefers `/usr/local/bin`, falling back to
//! `~/.local/bin` when that isn't writable; Linux goes straight to
//! `~/.local/bin`. Windows is deferred.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::debug_log;

#[cfg(not(target_os = "windows"))]
fn script_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    // Tauri flattens single-file resources: the `scripts/klaudio` entry lands
    // in `<Resources>/_up_/scripts/klaudio` on macOS when we use the
    // `bundle.resources` array syntax, but nests under `scripts/klaudio` on
    // the object form. Probe both.
    for candidate in [
        resource_dir.join("scripts/klaudio"),
        resource_dir.join("_up_/scripts/klaudio"),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("klaudio script not found under {}", resource_dir.display()))
}

#[cfg(not(target_os = "windows"))]
fn install_candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    v.push(PathBuf::from("/usr/local/bin/klaudio"));
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".local/bin/klaudio"));
    }
    v
}

#[cfg(not(target_os = "windows"))]
fn try_symlink(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Remove any stale file/symlink first; symlink() refuses to overwrite.
    let _ = std::fs::remove_file(target);
    std::os::unix::fs::symlink(source, target)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn install_cli(app: AppHandle) -> Result<String, String> {
    let script = script_path(&app)?;
    for target in install_candidates() {
        match try_symlink(&script, &target) {
            Ok(()) => {
                debug_log::write("cli", &format!("installed symlink at {}", target.display()));
                return Ok(target.to_string_lossy().into_owned());
            }
            Err(e) => {
                debug_log::write(
                    "cli",
                    &format!("install at {} failed: {e}", target.display()),
                );
            }
        }
    }
    Err("Could not install klaudio in any standard location. Try /usr/local/bin or ~/.local/bin manually.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn uninstall_cli() -> Result<(), String> {
    let mut removed_any = false;
    for target in install_candidates() {
        let is_link = std::fs::symlink_metadata(&target)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if target.exists() || is_link {
            std::fs::remove_file(&target)
                .map_err(|e| format!("failed to remove {}: {e}", target.display()))?;
            debug_log::write("cli", &format!("uninstalled {}", target.display()));
            removed_any = true;
        }
    }
    if !removed_any {
        return Err("klaudio was not installed in any known location.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn install_cli(_app: AppHandle) -> Result<String, String> {
    Err("klaudio CLI install is not yet supported on Windows.".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn uninstall_cli() -> Result<(), String> {
    Err("klaudio CLI uninstall is not yet supported on Windows.".to_string())
}
