pub mod binary;
pub mod claude;
pub mod sessions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(claude::ClaudeState::default())
        .invoke_handler(tauri::generate_handler![
            binary::get_claude_binary,
            sessions::list_sessions_for_project,
            sessions::list_session_entries,
            claude::claude_send,
            claude::claude_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
