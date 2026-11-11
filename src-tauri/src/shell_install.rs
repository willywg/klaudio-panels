//! Install / uninstall the `klaudio` shell wrapper in the user's PATH. The
//! script itself ships inside the .app bundle at
//! `<Resources>/scripts/klaudio`; we just symlink to it from a PATH-visible
//! location. macOS prefers `/usr/local/bin`, falling back to
//! `~/.local/bin` when that isn't writable; Linux goes straight to
//! `~/.local/bin`. On Windows, writes a `klaudio.cmd` wrapper into
//! `%LOCALAPPDATA%\Programs\klaudio` and ensures that directory is on the
//! user's `HKCU\Environment` `Path`.

use std::path::PathBuf;
use tauri::AppHandle;
#[cfg(not(target_os = "windows"))]
use tauri::Manager;

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

/// Windows batch wrapper for `klaudio [path]`.
///
/// Passes `%~f1` into `KLAUDIO_PATH` with delayed expansion off so characters
/// like `#`, `&`, `?`, `(`, `)`, and `'` are not re-interpreted by `cmd.exe`,
/// then URL-encodes the resolved path via `[uri]::EscapeDataString` before
/// invoking the `klaudio://` deep-link handler.
#[cfg(target_os = "windows")]
const WINDOWS_CLI_SCRIPT: &str = "@echo off\r\n\
setlocal DisableDelayedExpansion\r\n\
if \"%~1\"==\"\" (\r\n\
    start \"\" \"klaudio://open\"\r\n\
    exit /b 0\r\n\
)\r\n\
set \"KLAUDIO_PATH=%~f1\"\r\n\
powershell.exe -NoProfile -NonInteractive -Command \"$u = 'klaudio://open?path=' + [uri]::EscapeDataString($env:KLAUDIO_PATH); Start-Process -FilePath $u\"\r\n";

#[cfg(target_os = "windows")]
fn windows_install_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|local| local.join("Programs").join("klaudio"))
}

#[cfg(target_os = "windows")]
fn legacy_windows_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".cargo/bin/klaudio.cmd"));
        v.push(home.join(".local/bin/klaudio.cmd"));
        v.push(home.join("bin/klaudio.cmd"));
    }
    if let Some(local) = dirs::data_local_dir() {
        v.push(local.join("Microsoft/WindowsApps/klaudio.cmd"));
    }
    v
}

#[cfg(target_os = "windows")]
fn normalize_dir_for_compare(s: &str) -> String {
    s.trim()
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[cfg(target_os = "windows")]
fn append_dir_to_path(current: &str, dir: &str) -> Option<String> {
    let target = normalize_dir_for_compare(dir);
    if target.is_empty() {
        return None;
    }
    let already_present = current
        .split(';')
        .any(|entry| normalize_dir_for_compare(entry) == target);
    if already_present {
        return None;
    }
    let trimmed = current.trim_end_matches(';');
    if trimmed.is_empty() {
        Some(dir.to_string())
    } else {
        Some(format!("{trimmed};{dir}"))
    }
}

#[cfg(target_os = "windows")]
fn remove_dir_from_path(current: &str, dir: &str) -> Option<String> {
    let target = normalize_dir_for_compare(dir);
    if target.is_empty() {
        return None;
    }
    let mut kept = Vec::new();
    let mut removed = false;
    for entry in current.split(';') {
        if entry.is_empty() {
            continue;
        }
        if normalize_dir_for_compare(entry) == target {
            removed = true;
        } else {
            kept.push(entry);
        }
    }
    if removed {
        Some(kept.join(";"))
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
mod win_env {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    type Hkey = isize;
    const HKEY_CURRENT_USER: Hkey = -2147483647i32 as isize; // 0x80000001
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const REG_EXPAND_SZ: u32 = 2;
    const ERROR_SUCCESS: u32 = 0;
    const ERROR_FILE_NOT_FOUND: u32 = 2;
    const HWND_BROADCAST: isize = 0xffff;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            hkey: Hkey,
            lpsubkey: *const u16,
            uloptions: u32,
            samdesired: u32,
            phkresult: *mut Hkey,
        ) -> u32;
        fn RegQueryValueExW(
            hkey: Hkey,
            lpvaluename: *const u16,
            lpreserved: *const u32,
            lptype: *mut u32,
            lpdata: *mut u8,
            lpcbdata: *mut u32,
        ) -> u32;
        fn RegSetValueExW(
            hkey: Hkey,
            lpvaluename: *const u16,
            reserved: u32,
            dwtype: u32,
            lpdata: *const u8,
            cbdata: u32,
        ) -> u32;
        fn RegCloseKey(hkey: Hkey) -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: *const u16,
            fuflags: u32,
            utimeout: u32,
            lpdwresult: *mut usize,
        ) -> isize;
    }

    struct KeyGuard(Hkey);
    impl Drop for KeyGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn read_user_path() -> Result<(String, u32), String> {
        let subkey = to_wide("Environment");
        let value_name = to_wide("Path");
        let mut hkey: Hkey = 0;
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("Failed to open HKCU\\Environment (error {rc})"));
        }
        let _guard = KeyGuard(hkey);

        let mut kind: u32 = REG_EXPAND_SZ;
        let mut byte_len: u32 = 0;
        let rc = unsafe {
            RegQueryValueExW(
                hkey,
                value_name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut byte_len,
            )
        };
        if rc == ERROR_FILE_NOT_FOUND || byte_len == 0 {
            return Ok((String::new(), REG_EXPAND_SZ));
        }
        if rc != ERROR_SUCCESS {
            return Err(format!("Failed to query HKCU\\Environment\\Path size (error {rc})"));
        }

        let u16_len = (byte_len as usize).div_ceil(2);
        let mut buf = vec![0u16; u16_len];
        let mut actual_bytes = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegQueryValueExW(
                hkey,
                value_name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buf.as_mut_ptr() as *mut u8,
                &mut actual_bytes,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("Failed to read HKCU\\Environment\\Path (error {rc})"));
        }

        let valid_u16 = (actual_bytes as usize) / 2;
        let slice = &buf[..valid_u16];
        let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
        let val = OsString::from_wide(&slice[..end])
            .to_string_lossy()
            .into_owned();
        let target_kind = if kind == REG_SZ || kind == REG_EXPAND_SZ {
            kind
        } else {
            REG_EXPAND_SZ
        };
        Ok((val, target_kind))
    }

    pub fn write_user_path(new_path: &str, kind: u32) -> Result<(), String> {
        let subkey = to_wide("Environment");
        let value_name = to_wide("Path");
        let mut hkey: Hkey = 0;
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut hkey,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("Failed to open HKCU\\Environment for write (error {rc})"));
        }
        let wide = to_wide(new_path);
        let byte_len = (wide.len() * 2) as u32;
        let rc = unsafe {
            RegSetValueExW(
                hkey,
                value_name.as_ptr(),
                0,
                kind,
                wide.as_ptr() as *const u8,
                byte_len,
            )
        };
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        if rc != ERROR_SUCCESS {
            return Err(format!("Failed to update HKCU\\Environment\\Path (error {rc})"));
        }
        broadcast_environment_change();
        Ok(())
    }

    fn broadcast_environment_change() {
        let env_wide = to_wide("Environment");
        let mut result: usize = 0;
        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                env_wide.as_ptr(),
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );
        }
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn install_cli(_app: AppHandle) -> Result<String, String> {
    let dir = windows_install_dir()
        .ok_or_else(|| "Could not resolve %LOCALAPPDATA%\\Programs\\klaudio.".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    let target = dir.join("klaudio.cmd");
    std::fs::write(&target, WINDOWS_CLI_SCRIPT)
        .map_err(|e| format!("Failed to write {}: {e}", target.display()))?;

    let dir_str = dir.to_string_lossy().into_owned();
    let (current_path, kind) = win_env::read_user_path()?;
    if let Some(new_path) = append_dir_to_path(&current_path, &dir_str) {
        win_env::write_user_path(&new_path, kind)?;
        debug_log::write("cli", &format!("added {dir_str} to HKCU\\Environment\\Path"));
    }

    debug_log::write("cli", &format!("installed {}", target.display()));
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn uninstall_cli() -> Result<(), String> {
    let mut removed_any = false;
    if let Some(dir) = windows_install_dir() {
        let target = dir.join("klaudio.cmd");
        if target.exists() {
            std::fs::remove_file(&target)
                .map_err(|e| format!("failed to remove {}: {e}", target.display()))?;
            debug_log::write("cli", &format!("uninstalled {}", target.display()));
            removed_any = true;
        }
        let _ = std::fs::remove_dir(&dir);

        let dir_str = dir.to_string_lossy().into_owned();
        if let Ok((current_path, kind)) = win_env::read_user_path() {
            if let Some(new_path) = remove_dir_from_path(&current_path, &dir_str) {
                win_env::write_user_path(&new_path, kind)?;
                debug_log::write(
                    "cli",
                    &format!("removed {dir_str} from HKCU\\Environment\\Path"),
                );
                removed_any = true;
            }
        }
    }
    for legacy in legacy_windows_candidates() {
        if legacy.exists() && std::fs::remove_file(&legacy).is_ok() {
            debug_log::write("cli", &format!("uninstalled legacy {}", legacy.display()));
            removed_any = true;
        }
    }
    if !removed_any {
        return Err("klaudio was not installed in any known location.".to_string());
    }
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn windows_cli_script_url_encodes_special_path_characters() {
        assert!(WINDOWS_CLI_SCRIPT.contains("setlocal DisableDelayedExpansion"));
        assert!(WINDOWS_CLI_SCRIPT.contains("set \"KLAUDIO_PATH=%~f1\""));
        assert!(WINDOWS_CLI_SCRIPT.contains("[uri]::EscapeDataString($env:KLAUDIO_PATH)"));
    }

    #[test]
    fn append_dir_to_path_adds_once_and_ignores_case_and_trailing_slashes() {
        let dir = r"C:\Users\Alice\AppData\Local\Programs\klaudio";
        assert_eq!(
            append_dir_to_path("", dir),
            Some(r"C:\Users\Alice\AppData\Local\Programs\klaudio".to_string())
        );
        assert_eq!(
            append_dir_to_path(r"C:\Tools;", dir),
            Some(r"C:\Tools;C:\Users\Alice\AppData\Local\Programs\klaudio".to_string())
        );
        assert_eq!(
            append_dir_to_path(
                r"C:\Tools;c:\users\alice\appdata\local\programs\klaudio\;",
                dir
            ),
            None
        );
    }

    #[test]
    fn remove_dir_from_path_strips_target_and_preserves_other_entries() {
        let dir = r"C:\Users\Alice\AppData\Local\Programs\klaudio";
        assert_eq!(
            remove_dir_from_path(
                r"%USERPROFILE%\.cargo\bin;C:\Users\Alice\AppData\Local\Programs\klaudio\;C:\Tools",
                dir
            ),
            Some(r"%USERPROFILE%\.cargo\bin;C:\Tools".to_string())
        );
        assert_eq!(remove_dir_from_path(r"C:\Tools", dir), None);
    }
}
