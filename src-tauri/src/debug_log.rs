/// One-way log sink from the frontend to the Tauri dev-server stderr. The
/// webview can reload at any moment (e.g. after a WebKit crash), wiping the
/// Web Inspector console. Stderr from `bun tauri dev` survives that reload,
/// so we use it as the diagnostic channel for anything we actually need to
/// inspect post-mortem.
#[tauri::command]
pub fn debug_log(tag: String, msg: String) {
    eprintln!("[JS:{tag}] {msg}");
}
