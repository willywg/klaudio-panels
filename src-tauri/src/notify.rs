#[cfg(target_os = "macos")]
use std::process::Command;

use tauri::{AppHandle, Manager};

/// Fire a native macOS notification from the renderer.
///
/// We can't use `tauri-plugin-notification` because its underlying
/// `mac-notification-sys 0.6` crate relies on `NSUserNotificationCenter`,
/// which Apple has progressively gutted (deprecated in 10.14, removed
/// from macOS 26 / Tahoe). On Tahoe the plugin call returns success but
/// nothing is delivered — no banner, no Notification Center entry.
///
/// `osascript -e 'display notification ...'` still works on Tahoe via
/// the AppleScript Notifications service, which routes through the
/// modern UNUserNotificationCenter. Cosmetic caveat: the notification
/// shows AppleScript's icon, not Klaudio's. Acceptable trade for
/// "actually delivers" until the plugin is fixed upstream.
#[tauri::command]
pub fn notify_native(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escape_applescript(&body),
            escape_applescript(&title),
        );
        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map(|_| ())
            .map_err(|e| format!("osascript failed: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Ok(())
    }
}

/// Set (or clear) the macOS Dock badge count over the app icon.
///
/// Passing `0` clears the badge so the icon goes back to the bare app
/// glyph; any positive value renders the standard red bubble with the
/// number inside. We use this to show "you have N projects with Claude
/// turns waiting" awareness even when the Klaudio window is buried.
///
/// On non-macOS platforms `set_badge_count` is a no-op or unsupported;
/// we swallow the error so the renderer's fire-and-forget invoke
/// doesn't surface a misleading failure.
#[tauri::command]
pub fn set_dock_badge(app: AppHandle, count: u32) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not available".to_string())?;

    #[cfg(target_os = "windows")]
    {
        if count > 0 {
            use tauri::UserAttentionType;
            let _ = win.request_user_attention(Some(UserAttentionType::Informational));
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let value = if count == 0 { None } else { Some(count as i64) };
        win.set_badge_count(value).map_err(|e| e.to_string())
    }
}

/// AppleScript string literal escaping. The argument arrives via `-e`
/// as a single argv entry, so shell quoting is not a concern — only the
/// string-literal syntax inside the script. Escape order matters:
/// backslashes first (so we don't double-escape the ones we just
/// inserted for quotes), then double quotes, then collapse newlines so
/// the one-liner `-e` payload doesn't get split.
#[cfg(target_os = "macos")]
fn escape_applescript(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\n', '\r'], " ")
}
