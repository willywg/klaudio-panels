use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

use git2::{Delta, DiffOptions, Repository, Status, StatusOptions};
use serde::Serialize;

const MAX_DIFF_BYTES: usize = 512 * 1024;
pub(crate) const BINARY_PROBE_BYTES: usize = 8 * 1024;

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FileStatusKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileStatus {
    pub path: String,
    pub kind: FileStatusKind,
    pub staged: bool,
    pub adds: usize,
    pub dels: usize,
    pub is_binary: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitSummary {
    pub file_count: usize,
    pub adds: usize,
    pub dels: usize,
    pub branch: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffPayload {
    pub path: String,
    pub old_contents: Option<String>,
    pub new_contents: Option<String>,
    pub is_binary: bool,
    pub too_large: bool,
}

pub(crate) fn is_binary_bytes(bytes: &[u8]) -> bool {
    let probe_len = bytes.len().min(BINARY_PROBE_BYTES);
    bytes[..probe_len].contains(&0)
}

fn classify_delta(delta: Delta) -> FileStatusKind {
    match delta {
        Delta::Added => FileStatusKind::Added,
        Delta::Deleted => FileStatusKind::Deleted,
        Delta::Modified => FileStatusKind::Modified,
        Delta::Renamed => FileStatusKind::Renamed,
        Delta::Untracked => FileStatusKind::Untracked,
        Delta::Conflicted => FileStatusKind::Conflicted,
        _ => FileStatusKind::Modified,
    }
}

fn build_status(project_path: &str) -> Result<Vec<FileStatus>, String> {
    let repo = match Repository::open(project_path) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };

    // Index flags per path — we need these to populate `staged`.
    let mut status_opts = StatusOptions::new();
    status_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false);
    let statuses = repo
        .statuses(Some(&mut status_opts))
        .map_err(|e| e.to_string())?;
    let flags_by_path: HashMap<String, Status> = statuses
        .iter()
        .filter_map(|e| e.path().map(|p| (p.to_string(), e.status())))
        .collect();

    // Single diff: HEAD tree → workdir (with index). Includes untracked.
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

    let mut diff_opts = DiffOptions::new();
    diff_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .context_lines(0);

    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut diff_opts))
        .map_err(|e| e.to_string())?;

    let rows: RefCell<HashMap<String, FileStatus>> = RefCell::new(HashMap::new());

    diff.foreach(
        &mut |delta, _progress| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .and_then(|p| p.to_str())
                .map(String::from)
                .unwrap_or_default();
            if path.is_empty() {
                return true;
            }
            let kind = classify_delta(delta.status());
            let is_binary = delta.new_file().is_binary() || delta.old_file().is_binary();
            let staged = flags_by_path
                .get(&path)
                .map(|f| {
                    f.intersects(
                        Status::INDEX_NEW
                            | Status::INDEX_MODIFIED
                            | Status::INDEX_DELETED
                            | Status::INDEX_RENAMED
                            | Status::INDEX_TYPECHANGE,
                    )
                })
                .unwrap_or(false);
            rows.borrow_mut().insert(
                path.clone(),
                FileStatus {
                    path,
                    kind,
                    staged,
                    adds: 0,
                    dels: 0,
                    is_binary,
                },
            );
            true
        },
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .and_then(|p| p.to_str())
                .map(String::from)
                .unwrap_or_default();
            if let Some(row) = rows.borrow_mut().get_mut(&path) {
                match line.origin() {
                    '+' => row.adds += 1,
                    '-' => row.dels += 1,
                    _ => {}
                }
            }
            true
        }),
    )
    .map_err(|e| e.to_string())?;

    let mut out: Vec<FileStatus> = rows.into_inner().into_values().collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
pub fn git_status(project_path: String) -> Result<Vec<FileStatus>, String> {
    build_status(&project_path)
}

#[tauri::command]
pub fn git_summary(project_path: String) -> Result<GitSummary, String> {
    let repo = match Repository::open(&project_path) {
        Ok(r) => r,
        Err(_) => {
            return Ok(GitSummary {
                file_count: 0,
                adds: 0,
                dels: 0,
                branch: None,
            })
        }
    };

    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from));

    let status = build_status(&project_path)?;
    let (adds, dels) = status
        .iter()
        .fold((0usize, 0usize), |(a, d), row| (a + row.adds, d + row.dels));

    Ok(GitSummary {
        file_count: status.len(),
        adds,
        dels,
        branch,
    })
}

#[tauri::command]
pub fn git_diff_file(
    project_path: String,
    rel_path: String,
) -> Result<DiffPayload, String> {
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let rel = Path::new(&rel_path);
    let full = Path::new(&project_path).join(rel);

    // Workdir side — may be absent if the file was deleted.
    let (new_contents, new_is_binary, new_too_large) = match std::fs::read(&full) {
        Ok(bytes) => {
            if bytes.len() > MAX_DIFF_BYTES {
                (None, false, true)
            } else if is_binary_bytes(&bytes) {
                (None, true, false)
            } else {
                (Some(String::from_utf8_lossy(&bytes).into_owned()), false, false)
            }
        }
        Err(_) => (None, false, false),
    };

    // HEAD side — may be absent on fresh repo or for untracked files.
    let head_blob_bytes = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
        .and_then(|tree| tree.get_path(rel).ok())
        .and_then(|entry| entry.to_object(&repo).ok())
        .and_then(|obj| obj.into_blob().ok())
        .map(|blob| blob.content().to_vec());

    let (old_contents, old_is_binary, old_too_large) = match head_blob_bytes {
        Some(bytes) => {
            if bytes.len() > MAX_DIFF_BYTES {
                (None, false, true)
            } else if is_binary_bytes(&bytes) {
                (None, true, false)
            } else {
                (Some(String::from_utf8_lossy(&bytes).into_owned()), false, false)
            }
        }
        None => (None, false, false),
    };

    Ok(DiffPayload {
        path: rel_path,
        old_contents,
        new_contents,
        is_binary: new_is_binary || old_is_binary,
        too_large: new_too_large || old_too_large,
    })
}
