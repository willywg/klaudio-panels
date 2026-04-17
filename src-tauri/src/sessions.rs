// T3 — stub. Implementación real en la siguiente tarea.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub timestamp: Option<String>,
    pub first_message_preview: Option<String>,
    pub project_path: String,
}

#[tauri::command]
pub fn list_sessions_for_project(_project_path: String) -> Result<Vec<SessionMeta>, String> {
    Ok(vec![])
}

#[tauri::command]
pub fn list_session_entries(_session_id: String) -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}
