use std::process::Command;

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

/// AppleScript string literal escaping. The argument arrives via `-e`
/// as a single argv entry, so shell quoting is not a concern — only the
/// string-literal syntax inside the script. Escape order matters:
/// backslashes first (so we don't double-escape the ones we just
/// inserted for quotes), then double quotes, then collapse newlines so
/// the one-liner `-e` payload doesn't get split.
fn escape_applescript(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ")
        .replace('\r', " ")
}
