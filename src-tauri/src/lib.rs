pub mod binary;
pub mod cli_args;
pub mod debug_log;
pub mod file_read;
pub mod fs;
pub mod git;
pub mod open_in;
pub mod pty;
pub mod session_watcher;
pub mod sessions;
pub mod shell_env;
pub mod shell_install;

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
    use tauri::Emitter;
    use tauri::menu::{Menu, MenuItem, Submenu};

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
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
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_for_url = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        cli_args::handle_url(&app_for_url, url.as_str());
                    }
                });
            }
            // Append a "Klaudio" submenu to the default OS menu bar with the
            // Install / Uninstall CLI items. These just emit intents to the
            // frontend which invokes the Tauri commands and shows the result
            // dialog — keeps all dialog plumbing on the JS side.
            {
                let install_item = MenuItem::with_id(
                    app,
                    "install_cli",
                    "Install 'klaudio' Command in PATH",
                    true,
                    None::<&str>,
                )?;
                let uninstall_item = MenuItem::with_id(
                    app,
                    "uninstall_cli",
                    "Uninstall 'klaudio' Command from PATH",
                    true,
                    None::<&str>,
                )?;
                let submenu = Submenu::with_items(
                    app,
                    "Klaudio",
                    true,
                    &[&install_item, &uninstall_item],
                )?;
                let menu = Menu::default(app.handle())?;
                menu.append(&submenu)?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| match event.id.as_ref() {
                    "install_cli" => {
                        let _ = app.emit("menu:install-cli", ());
                    }
                    "uninstall_cli" => {
                        let _ = app.emit("menu:uninstall-cli", ());
                    }
                    _ => {}
                });
            }
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
            fs::list_files_recursive,
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
            shell_install::install_cli,
            shell_install::uninstall_cli,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
