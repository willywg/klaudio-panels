use serde_json::Value;

const WARP_PLUGIN_KEY: &str = "warp@claude-code-warp";

/// Whether the warp/claude-code-warp Claude Code plugin is currently
/// installed in the user's `~/.claude` config.
///
/// We read `~/.claude/plugins/installed_plugins.json` and check for a
/// `plugins["warp@claude-code-warp"]` entry with at least one item. The
/// schema (version 2 at the time of writing) maps each
/// `<plugin>@<marketplace>` key to an array of install records. Any
/// failure (missing file, bad JSON, schema drift) returns `false` —
/// "we couldn't confirm" is treated as "not installed" so the UI errs
/// on the side of guiding the user to install.
#[tauri::command]
pub fn is_warp_plugin_installed() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let path = home.join(".claude/plugins/installed_plugins.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    json.get("plugins")
        .and_then(|p| p.get(WARP_PLUGIN_KEY))
        .and_then(|v| v.as_array())
        .map(|arr| !arr.is_empty())
        .unwrap_or(false)
}
