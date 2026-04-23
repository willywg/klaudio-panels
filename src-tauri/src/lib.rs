pub mod binary;
pub mod debug_log;
pub mod file_read;
pub mod fs;
pub mod git;
pub mod open_in;
pub mod pty;
pub mod session_watcher;
pub mod sessions;
pub mod shell_env;

/// Best-effort restoration of the outer terminal's tty modes when we exit.
/// `bun tauri dev` runs cargo + vite inside the user's iTerm/Warp. If any
/// of those (or we) enter the alt-screen buffer, bracketed-paste, or mouse
/// reporting and die without emitting the matching OFF sequence, the
/// terminal is left in that mode — visible as a black panel with a
/// blinking cursor until the user types `reset`. Drop fires on clean exit
/// AND on panic unwind (not SIGKILL, but that's rare).
///
/// Sequences, in order: exit alt-screen, show cursor, disable bracketed
/// paste, disable mouse tracking (click / drag / any), disable
/// focus-change reporting. All are safe no-ops when the mode wasn't on.
struct TtyGuard;

impl Drop for TtyGuard {
    fn drop(&mut self) {
        use std::io::Write;
        let _ = std::io::stderr().write_all(
            b"\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l",
        );
        let _ = std::io::stderr().flush();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _tty_guard = TtyGuard;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty::PtyState::default())
        .manage(fs::FsWatcherState::default())
        .setup(|app| {
            if let Some(p) = debug_log::log_file_path() {
                debug_log::write(
                    "boot",
                    &format!("Klaudio Panels starting — log at {}", p.display()),
                );
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = session_watcher::install(handle) {
                    debug_log::write("boot", &format!("session_watcher install failed: {e}"));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            binary::get_claude_binary,
            sessions::list_sessions_for_project,
            pty::pty_open,
            pty::pty_open_editor,
            pty::pty_open_shell,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            shell_env::check_binary_exists,
            debug_log::debug_log,
            debug_log::get_log_path,
            fs::list_dir,
            fs::watch_project,
            fs::unwatch_project,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_delete,
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
