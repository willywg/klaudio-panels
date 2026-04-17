// Placeholder — real implementation in T4.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<String, ()>>,
}

#[tauri::command]
pub async fn pty_open(
    _project_path: String,
    _args: Vec<String>,
) -> Result<String, String> {
    Err("pty_open not implemented yet".into())
}

#[tauri::command]
pub async fn pty_write(_id: String, _b64: String) -> Result<(), String> {
    Err("pty_write not implemented yet".into())
}

#[tauri::command]
pub async fn pty_resize(_id: String, _cols: u16, _rows: u16) -> Result<(), String> {
    Err("pty_resize not implemented yet".into())
}

#[tauri::command]
pub async fn pty_kill(_id: String) -> Result<(), String> {
    Err("pty_kill not implemented yet".into())
}
