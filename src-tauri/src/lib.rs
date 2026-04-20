pub mod binary;
pub mod file_read;
pub mod fs;
pub mod git;
pub mod open_in;
pub mod pty;
pub mod session_watcher;
pub mod sessions;
pub mod shell_env;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(fs::FsWatcherState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = session_watcher::install(handle) {
                    eprintln!("session_watcher install failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            binary::get_claude_binary,
            sessions::list_sessions_for_project,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            fs::list_dir,
            fs::watch_project,
            fs::unwatch_project,
            git::git_status,
            git::git_summary,
            git::git_diff_file,
            open_in::check_app_exists,
            open_in::open_path_with,
            open_in::get_app_icon,
            file_read::read_file_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
