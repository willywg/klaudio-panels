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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "klaudio-write-test-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Reads reach outside the project (`resolve_readable`, #85); writes do
    /// not, and that asymmetry is the point rather than an oversight. Klaudio
    /// never writing outside a project you opened is a property worth being
    /// able to state, so it gets a test rather than only a comment.
    #[test]
    fn an_absolute_path_outside_the_project_is_refused() {
        let outside = TempDir::new("outside");
        let target = outside.0.join("victim.txt");
        fs::write(&target, "original").unwrap();
        let project = TempDir::new("project");

        let err = write_file_bytes(
            project.0.display().to_string(),
            target.display().to_string(),
            "overwritten".into(),
            None,
        )
        .unwrap_err();

        assert!(err.contains("escapes project root"), "got {err}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
    }

    #[test]
    fn a_path_inside_the_project_writes() {
        let project = TempDir::new("inside");
        fs::write(project.0.join("notes.md"), "before").unwrap();

        write_file_bytes(
            project.0.display().to_string(),
            "notes.md".into(),
            "after".into(),
            None,
        )
        .expect("write inside the project");

        assert_eq!(
            fs::read_to_string(project.0.join("notes.md")).unwrap(),
            "after"
        );
    }
}
