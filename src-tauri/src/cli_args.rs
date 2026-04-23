//! Handler for deep-link URLs (`klaudio://open?path=<abs-path>`) fired by the
//! `klaudio` shell wrapper. Parses the URL, decides whether the path is a
//! project directory or a file (project = its parent dir in that case), and
//! emits `cli:open` to the frontend.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use crate::debug_log;

#[derive(Debug, Serialize, Clone)]
pub struct CliOpenPayload {
    pub project_path: String,
    pub file_path: Option<String>,
}

/// Extract a single path from an incoming `klaudio://open?path=<url-encoded>`
/// URL. Returns `None` if the URL is malformed, lacks a `path` query param,
/// or the param is empty. Non-`klaudio` schemes are ignored.
fn extract_path(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "klaudio" {
        return None;
    }
    parsed
        .query_pairs()
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty())
}

/// Turn an absolute path into `(project_path, file_path?)`. Directories become
/// the project directly; files hoist the project to their parent. Non-existent
/// paths fall through as project-only (frontend can surface the error).
fn classify(raw: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    if !raw.is_absolute() {
        return None;
    }
    match std::fs::metadata(raw) {
        Ok(md) if md.is_dir() => Some((raw.to_path_buf(), None)),
        Ok(md) if md.is_file() => {
            let parent = raw.parent()?.to_path_buf();
            Some((parent, Some(raw.to_path_buf())))
        }
        _ => Some((raw.to_path_buf(), None)),
    }
}

/// Entry point for each URL delivered by `tauri_plugin_deep_link::on_open_url`.
/// Called once per URL (the plugin batches them into a Vec<Url>, we iterate).
pub fn handle_url(app: &AppHandle, url: &str) {
    let Some(raw) = extract_path(url) else {
        debug_log::write("cli", &format!("ignored non-klaudio or malformed url: {url}"));
        return;
    };
    let Some((project, file)) = classify(Path::new(&raw)) else {
        debug_log::write("cli", &format!("ignored non-absolute path in url: {raw}"));
        return;
    };
    let payload = CliOpenPayload {
        project_path: project.to_string_lossy().into_owned(),
        file_path: file.map(|p| p.to_string_lossy().into_owned()),
    };
    debug_log::write("cli", &format!("cli:open emit {payload:?}"));
    if let Err(e) = app.emit("cli:open", &payload) {
        debug_log::write("cli", &format!("emit failed: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_encoded_path() {
        let got = extract_path("klaudio://open?path=/Users/foo/my%20project").unwrap();
        assert_eq!(got, "/Users/foo/my project");
    }

    #[test]
    fn ignores_other_schemes() {
        assert!(extract_path("http://example.com?path=/foo").is_none());
    }

    #[test]
    fn ignores_missing_query() {
        assert!(extract_path("klaudio://open").is_none());
    }

    #[test]
    fn classify_rejects_relative() {
        assert!(classify(Path::new("relative/path")).is_none());
    }
}
