// T5 — stub. Implementación real en la siguiente tarea.

use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct ClaudeState {
    pub current: Arc<Mutex<Option<tokio::process::Child>>>,
}

#[tauri::command]
pub async fn claude_send(
    _project_path: String,
    _prompt: String,
    _model: String,
    _resume_session_id: Option<String>,
) -> Result<(), String> {
    Err("not implemented yet".into())
}

#[tauri::command]
pub async fn claude_cancel() -> Result<(), String> {
    Ok(())
}
