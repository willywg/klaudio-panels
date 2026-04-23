//! File-based diagnostic log. Writes to
//! `~/Library/Logs/Klaudio Panels/klaudio.log` on macOS so end-users can ship
//! their log without enabling dev tools. Also mirrors to stderr when we're
//! running under `bun tauri dev` for live tail-ability.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

fn log_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    #[cfg(target_os = "macos")]
    let dir = home.join("Library/Logs/Klaudio Panels");
    #[cfg(not(target_os = "macos"))]
    let dir = home.join(".klaudio-panels").join("logs");
    Some(dir)
}

pub fn log_file_path() -> Option<PathBuf> {
    log_dir().map(|d| d.join("klaudio.log"))
}

static WRITER: Mutex<Option<std::fs::File>> = Mutex::new(None);

fn ensure_writer() -> Option<std::sync::MutexGuard<'static, Option<std::fs::File>>> {
    let mut guard = WRITER.lock().ok()?;
    if guard.is_none() {
        let dir = log_dir()?;
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("klaudio.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        *guard = Some(file);
    }
    Some(guard)
}

fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = chrono::DateTime::from_timestamp(now as i64, 0)
        .unwrap_or_default()
        .with_timezone(&chrono::Local);
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Append a line to the log file and mirror to stderr.
pub fn write(tag: &str, msg: &str) {
    let line = format!("{} [{}] {}\n", timestamp(), tag, msg);
    eprint!("{line}");
    if let Some(mut guard) = ensure_writer() {
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }
}

/// Tauri command: frontend-originated log line.
#[tauri::command]
pub fn debug_log(tag: String, msg: String) {
    write(&format!("JS:{tag}"), &msg);
}

/// Tauri command: return the log file path so the UI can link to it.
#[tauri::command]
pub fn get_log_path() -> Option<String> {
    log_file_path().and_then(|p| p.to_str().map(|s| s.to_string()))
}
