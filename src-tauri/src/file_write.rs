use serde::Serialize;

use crate::file_read::{mtime_ms, resolve_rel, MAX_PREVIEW_BYTES};

#[derive(Debug, Serialize, Clone)]
pub struct WriteResult {
    pub bytes: u64,
    pub mtime_ms: i64,
}

#[tauri::command]
pub fn write_file_bytes(
    project_path: String,
    rel_path: String,
    contents: String,
    expected_mtime_ms: Option<i64>,
) -> Result<WriteResult, String> {
    let abs = resolve_rel(&project_path, &rel_path)?;

    if let Some(expected) = expected_mtime_ms {
        let cur = std::fs::metadata(&abs)
            .map(|m| mtime_ms(&m))
            .map_err(|e| format!("stat: {e}"))?;
        if cur != expected {
            return Err("stale".into());
        }
    }

    let bytes = contents.as_bytes();
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("file exceeds 1 MiB write cap".into());
    }

    std::fs::write(&abs, bytes).map_err(|e| format!("write: {e}"))?;

    let meta = std::fs::metadata(&abs).map_err(|e| format!("stat: {e}"))?;
    Ok(WriteResult {
        bytes: meta.len(),
        mtime_ms: mtime_ms(&meta),
    })
}
