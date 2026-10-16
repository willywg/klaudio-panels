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
        if which::which(bin_name).is_ok() {
            return true;
        }
        if let Some(local) = dirs::data_local_dir() {
            let programs = local.join("Programs");
            match bin_name {
                "code" => {
                    if programs.join("Microsoft VS Code/bin/code.cmd").exists()
                        || programs.join("Microsoft VS Code/Code.exe").exists()
                    {
                        return true;
                    }
                }
                "cursor" => {
                    if programs.join("cursor/Cursor.exe").exists() {
                        return true;
                    }
                }
                "windsurf" => {
                    if programs.join("Windsurf/Windsurf.exe").exists() {
                        return true;
                    }
                }
                "antigravity" => {
                    if programs.join("antigravity/antigravity.exe").exists() {
                        return true;
                    }
                }
                _ => {}
            }
        }
        if let Some(prog) = std::env::var_os("ProgramFiles") {
            let path = std::path::Path::new(&prog);
            match bin_name {
                "code" => {
                    if path.join("Microsoft VS Code/bin/code.cmd").exists()
                        || path.join("Microsoft VS Code/Code.exe").exists()
                    {
                        return true;
                    }
                }
                "subl" => {
                    if path.join("Sublime Text/sublime_text.exe").exists() {
                        return true;
                    }
                }
                "wezterm" => {
                    if path.join("WezTerm/wezterm.exe").exists() {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        which::which(&app_name).is_ok()
    }
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
fn resolve_windows_bin(bin: &str) -> (String, bool) {
    if bin == "code" {
        if let Some(local) = dirs::data_local_dir() {
            let exe = local.join("Programs/Microsoft VS Code/Code.exe");
            if exe.exists() {
                return (exe.to_string_lossy().into_owned(), false);
            }
            let cmd = local.join("Programs/Microsoft VS Code/bin/code.cmd");
            if cmd.exists() {
                return (cmd.to_string_lossy().into_owned(), true);
            }
        }
        if let Some(prog) = std::env::var_os("ProgramFiles") {
            let p = std::path::Path::new(&prog);
            let exe = p.join("Microsoft VS Code/Code.exe");
            if exe.exists() {
                return (exe.to_string_lossy().into_owned(), false);
            }
            let cmd = p.join("Microsoft VS Code/bin/code.cmd");
            if cmd.exists() {
                return (cmd.to_string_lossy().into_owned(), true);
            }
        }
    }
    let is_batch = bin.ends_with(".cmd") || bin.ends_with(".bat");
    (bin.to_string(), is_batch)
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
            let (target, is_batch) = resolve_windows_bin(bin);
            if is_batch {
                let mut cmd = std::process::Command::new("cmd");
                cmd.args(["/d", "/c", &target, &path]);
                cmd.creation_flags(CREATE_NO_WINDOW);
                cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
            } else {
                let mut cmd = std::process::Command::new(&target);
                cmd.arg(&path);
                cmd.creation_flags(CREATE_NO_WINDOW);
                cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
            }
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
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty)
        }?;
        Some(png.to_vec())
    })
}
