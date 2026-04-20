use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::{is_binary_bytes, BINARY_PROBE_BYTES};

const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
pub struct FilePayload {
    pub path: String,
    pub contents: Option<String>,
    pub is_binary: bool,
    pub too_large: bool,
    pub bytes: u64,
}

fn resolve_rel(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let base = Path::new(project_path);
    let candidate = base.join(rel);
    let canon_base = base
        .canonicalize()
        .map_err(|e| format!("canonicalize project: {e}"))?;
    let canon = candidate
        .canonicalize()
        .map_err(|e| format!("canonicalize file: {e}"))?;
    if !canon.starts_with(&canon_base) {
        return Err("path escapes project root".into());
    }
    Ok(canon)
}

#[tauri::command]
pub fn read_file_bytes(project_path: String, rel_path: String) -> Result<FilePayload, String> {
    let abs = resolve_rel(&project_path, &rel_path)?;
    let meta = std::fs::metadata(&abs).map_err(|e| format!("stat: {e}"))?;
    let bytes = meta.len();

    if bytes > MAX_PREVIEW_BYTES {
        return Ok(FilePayload {
            path: rel_path,
            contents: None,
            is_binary: false,
            too_large: true,
            bytes,
        });
    }

    let data = std::fs::read(&abs).map_err(|e| format!("read: {e}"))?;

    let probe_len = data.len().min(BINARY_PROBE_BYTES);
    if is_binary_bytes(&data[..probe_len]) {
        return Ok(FilePayload {
            path: rel_path,
            contents: None,
            is_binary: true,
            too_large: false,
            bytes,
        });
    }

    let contents = String::from_utf8_lossy(&data).into_owned();
    Ok(FilePayload {
        path: rel_path,
        contents: Some(contents),
        is_binary: false,
        too_large: false,
        bytes,
    })
}
