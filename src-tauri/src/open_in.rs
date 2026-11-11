#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(target_os = "macos")]
fn find_app_bundle(app_name: &str) -> Option<String> {
    let mut candidates = vec![
        format!("/Applications/{app_name}.app"),
        format!("/System/Applications/{app_name}.app"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/Applications/{app_name}.app"));
    }
    candidates
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
}

#[cfg(target_os = "windows")]
fn map_app_to_windows_bin(app_name: &str) -> Option<&'static str> {
    match app_name {
        "Visual Studio Code" | "vscode" | "code" => Some("code"),
        "Cursor" | "cursor" => Some("cursor"),
        "Windsurf" | "windsurf" => Some("windsurf"),
        "Antigravity" | "antigravity" => Some("antigravity"),
        "Sublime Text" | "sublime" | "subl" => Some("subl"),
        "Zed" | "zed" => Some("zed"),
        "IntelliJ IDEA" | "intellij" => Some("idea"),
        "WebStorm" | "webstorm" => Some("webstorm"),
        "PyCharm" | "pycharm" => Some("pycharm"),
        "Android Studio" => Some("studio"),
        "WezTerm" | "wezterm" => Some("wezterm"),
        "Finder" | "File Explorer" | "explorer" => None,
        _ => None,
    }
}

/// Check if an app is installed.
/// macOS: standard Applications bundles + `which`.
/// Windows: probe known bin aliases via `which` and common install locations.
#[tauri::command]
pub fn check_app_exists(app_name: String) -> bool {
    #[cfg(target_os = "macos")]
    {
        if find_app_bundle(&app_name).is_some() {
            return true;
        }
        Command::new("which")
            .arg(&app_name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[cfg(target_os = "windows")]
    {
        if app_name == "Finder" || app_name == "File Explorer" || app_name == "explorer" {
            return true;
        }
        let bin_name = map_app_to_windows_bin(&app_name).unwrap_or(&app_name);
        resolve_windows_bin(bin_name).is_some()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        which::which(&app_name).is_ok()
    }
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_editors_use_the_same_known_paths_for_detection_and_launch() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let local =
            std::env::temp_dir().join(format!("klaudio-editors-{}-{nonce}", std::process::id()));
        for (bin, relative) in [
            ("code", "Programs/Microsoft VS Code/Code.exe"),
            ("cursor", "Programs/cursor/Cursor.exe"),
            ("windsurf", "Programs/Windsurf/Windsurf.exe"),
            ("antigravity", "Programs/antigravity/antigravity.exe"),
        ] {
            let exe = local.join(relative);
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(&exe, b"test fixture").unwrap();
            assert_eq!(resolve_windows_install(bin, Some(&local), None), Some(exe));
        }
        assert_eq!(resolve_windows_install("missing", Some(&local), None), None);
        let system_exe = local.join("system/Sublime Text/sublime_text.exe");
        std::fs::create_dir_all(system_exe.parent().unwrap()).unwrap();
        std::fs::write(&system_exe, b"test fixture").unwrap();
        assert_eq!(
            resolve_windows_install("subl", None, Some(&local.join("system"))),
            Some(system_exe)
        );
        let batch = local.join("batch/Programs/Microsoft VS Code/bin/code.cmd");
        std::fs::create_dir_all(batch.parent().unwrap()).unwrap();
        std::fs::write(&batch, b"@echo off").unwrap();
        assert_eq!(
            resolve_windows_install("code", Some(&local.join("batch")), None),
            Some(batch)
        );
        std::fs::remove_dir_all(&local).unwrap();
    }
}

#[cfg(target_os = "windows")]
fn resolve_windows_bin(bin: &str) -> Option<std::path::PathBuf> {
    let local = dirs::data_local_dir();
    let program_files = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from);
    resolve_windows_install(bin, local.as_deref(), program_files.as_deref())
        .or_else(|| which::which(bin).ok())
}

#[cfg(target_os = "windows")]
fn resolve_windows_install(
    bin: &str,
    local: Option<&std::path::Path>,
    program_files: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    let relative: &[&str] = match bin {
        "code" => &[
            "Microsoft VS Code/Code.exe",
            "Microsoft VS Code/bin/code.cmd",
        ],
        "cursor" => &["cursor/Cursor.exe", "cursor/resources/app/bin/cursor.cmd"],
        "windsurf" => &["Windsurf/Windsurf.exe", "Windsurf/bin/windsurf.cmd"],
        "antigravity" => &["antigravity/antigravity.exe", "Antigravity/Antigravity.exe"],
        "subl" => &["Sublime Text/sublime_text.exe"],
        "wezterm" => &["WezTerm/wezterm.exe"],
        _ => &[],
    };
    [
        local.map(|p| p.join("Programs")),
        program_files.map(std::path::Path::to_path_buf),
    ]
    .into_iter()
    .flatten()
    .flat_map(|root| relative.iter().map(move |path| root.join(path)))
    .find(|path| path.is_file())
}

/// Open `path` with the given app (display name or command alias)
/// or with the system default when `app_name` is `None`.
#[tauri::command]
pub fn open_path_with(path: String, app_name: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let target_bin = app_name.as_deref().and_then(map_app_to_windows_bin);
        if let Some(bin) = target_bin {
            let target =
                resolve_windows_bin(bin).ok_or_else(|| format!("could not find editor: {bin}"))?;
            // Rust applies batch-file argument escaping for explicit .cmd/.bat paths.
            let mut cmd = std::process::Command::new(&target);
            cmd.arg(&path);
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
        } else {
            tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        tauri_plugin_opener::open_path(path, app_name.as_deref()).map_err(|e| e.to_string())
    }
}

/// macOS: extract the real icon of an installed `.app` bundle and return it
/// as a PNG data URL (base64-encoded). Uses `NSWorkspace iconForFile:` which
/// handles both classic `.icns` bundles and asset-catalog-based modern apps.
#[tauri::command]
pub fn get_app_icon(app_name: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine as _;
        let bundle = find_app_bundle(&app_name).ok_or_else(|| "app not found".to_string())?;
        let png = render_app_icon_png(&bundle).ok_or_else(|| "icon render failed".to_string())?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        Ok(format!("data:image/png;base64,{b64}"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("unsupported platform".into())
    }
}

#[cfg(target_os = "macos")]
fn render_app_icon_png(app_bundle_path: &str) -> Option<Vec<u8>> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSString};

    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let ns_path = NSString::from_str(app_bundle_path);
        let icon = workspace.iconForFile(&ns_path);
        let tiff = icon.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        let empty = NSDictionary::new();
        let png =
            unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty) }?;
        Some(png.to_vec())
    })
}
