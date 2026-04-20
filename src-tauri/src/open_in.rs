use std::process::Command;

/// macOS: check if an app is installed by probing standard Applications
/// directories + falling back to `which`. Returns `false` on other OSes
/// for now — Linux/Windows deferred to a later sprint.
#[tauri::command]
pub fn check_app_exists(app_name: String) -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![
            format!("/Applications/{app_name}.app"),
            format!("/System/Applications/{app_name}.app"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(format!("{home}/Applications/{app_name}.app"));
        }
        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return true;
            }
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
