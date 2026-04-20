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

/// macOS: check if an app is installed by probing standard Applications
/// directories + falling back to `which`. Returns `false` on other OSes
/// for now — Linux/Windows deferred to a later sprint.
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

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        false
    }
}

/// Open `path` with the given app (by macOS display name, e.g. "Visual Studio Code")
/// or with the system default when `app_name` is `None`.
#[tauri::command]
pub fn open_path_with(path: String, app_name: Option<String>) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, app_name.as_deref()).map_err(|e| e.to_string())
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
