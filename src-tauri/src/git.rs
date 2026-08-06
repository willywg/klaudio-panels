use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use git2::{Delta, DiffOptions, Repository, Status, StatusOptions};
use serde::Serialize;

const MAX_DIFF_BYTES: usize = 512 * 1024;
pub(crate) const BINARY_PROBE_BYTES: usize = 8 * 1024;

/// How deep we follow nested repos (submodule inside a submodule inside…).
/// Each level costs one `Repository::open` + status walk per refresh; three
/// covers every real layout we've seen and bounds a pathological one.
const MAX_NESTED_REPO_DEPTH: usize = 3;

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
    /// Path relative to the **project root**, submodule prefix included
    /// (`backend/app/models/user.rb`). Every consumer joins this onto the
    /// project path to get an absolute path, so it stays project-relative
    /// even for files owned by a nested repo.
    pub path: String,
    /// Which repo owns this file, as a project-relative path. Empty string
    /// for the project's own repo. Used to group the panel by child project.
    pub repo: String,
    pub kind: FileStatusKind,
    pub staged: bool,
    pub adds: usize,
    pub dels: usize,
    pub is_binary: bool,
    /// Set when this row is a submodule gitlink rather than a file — the
    /// child's worktree is clean and the only change is which commit the
    /// pointer names. There is no file to diff (the path is a directory), so
    /// the panel renders the commit move instead.
    pub submodule: Option<SubmoduleMove>,
}

/// A submodule pointer that moved between HEAD and the working tree.
#[derive(Debug, Serialize, Clone)]
pub struct SubmoduleMove {
    /// Commit the superproject's HEAD still points at.
    pub old_sha: Option<String>,
    /// Commit the child repo is actually checked out at.
    pub new_sha: Option<String>,
    /// Subject line of the new commit, when the child can resolve it.
    pub new_summary: Option<String>,
}

/// One repo contributing to the status: the project itself plus any nested
/// repo (submodule or plain checked-in clone) we descended into.
#[derive(Debug, Serialize, Clone)]
pub struct RepoInfo {
    /// Project-relative path; empty string for the project's own repo.
    pub path: String,
    /// Branch name, or `detached @ <short sha>`. Submodules usually sit
    /// detached, and not seeing that is how you lose work in one.
    pub branch: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct StatusPayload {
    pub files: Vec<FileStatus>,
    pub repos: Vec<RepoInfo>,
    /// Rolled up here rather than behind its own command: the summary is a
    /// fold over exactly this file list, and computing it separately meant
    /// walking every repo twice per refresh.
    pub summary: GitSummary,
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

/// Status of a single repo, with paths relative to *that* repo's workdir.
/// `repo` is left empty here; `scan_repo` rewrites both fields once it knows
/// where this repo sits inside the project.
fn raw_status(repo: &Repository) -> Result<Vec<FileStatus>, String> {
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
        // Without this libgit2 emits the delta for an untracked file but
        // never its content, so the line callback below never fires and
        // every new file reported `+0 −0`. Ignored files are still excluded,
        // so this doesn't wander into node_modules.
        .show_untracked_content(true)
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
                    repo: String::new(),
                    kind,
                    staged,
                    adds: 0,
                    dels: 0,
                    is_binary,
                    submodule: None,
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

/// Branch label for a repo header. Detached HEAD gets the short sha instead
/// of git2's literal `HEAD`, which tells you nothing.
fn head_label(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if repo.head_detached().unwrap_or(false) {
        let sha = head.target()?.to_string();
        return Some(format!("detached @ {}", &sha[..7.min(sha.len())]));
    }
    head.shorthand().map(String::from)
}

/// A directory that is itself a repo. `.git` is a directory in a plain clone
/// and a file (`gitdir: …`) in a submodule checkout — `exists()` covers both.
/// An uninitialised submodule has neither, so it correctly stays a plain row.
fn is_nested_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// Describe a moved submodule pointer: where the superproject still thinks
/// the child is, versus where it actually is. Returns `None` when neither
/// side resolves — an untracked nested clone, say, which was never a gitlink
/// and so has no pointer to have moved.
fn submodule_move(parent: &Repository, rel: &str, child_abs: &Path) -> Option<SubmoduleMove> {
    let old_sha = parent
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
        .and_then(|t| t.get_path(Path::new(rel)).ok())
        .map(|e| e.id().to_string());

    let child = Repository::open(child_abs).ok();
    let new_oid = child
        .as_ref()
        .and_then(|c| c.head().ok())
        .and_then(|h| h.target());

    if old_sha.is_none() && new_oid.is_none() {
        return None;
    }

    let new_summary = child.as_ref().zip(new_oid).and_then(|(c, oid)| {
        c.find_commit(oid)
            .ok()
            .and_then(|commit| commit.summary().map(String::from))
    });

    Some(SubmoduleMove {
        old_sha,
        new_sha: new_oid.map(|o| o.to_string()),
        new_summary,
    })
}

/// Walk `root`'s status, descending into any nested repo it reports.
///
/// A submodule shows up in the superproject as a single gitlink delta —
/// `M backend  +1 −1` — because the only thing that changed from the
/// superproject's point of view is the commit the pointer names. That row is
/// useless: it hides however many real file changes live inside the child
/// repo. So when a row turns out to be a repo, we open it and splice in its
/// own status under a `backend/…` prefix instead.
///
/// The pointer row is kept when the child has nothing dirty, since then the
/// moved pointer *is* the change and dropping the row would make it vanish.
fn scan_repo(
    root: &Path,
    prefix: &str,
    depth: usize,
    files: &mut Vec<FileStatus>,
    repos: &mut Vec<RepoInfo>,
) {
    let repo = match Repository::open(root) {
        Ok(r) => r,
        Err(_) => return,
    };
    let rows = match raw_status(&repo) {
        Ok(r) => r,
        Err(err) => {
            crate::debug_log::write(
                "git",
                &format!("status failed for {}: {err}", root.display()),
            );
            return;
        }
    };

    let repo_key = prefix.trim_end_matches('/').to_string();
    repos.push(RepoInfo {
        path: repo_key.clone(),
        branch: head_label(&repo),
    });

    for mut row in rows {
        // libgit2 reports untracked directories with a trailing slash.
        let child_rel = row.path.trim_end_matches('/').to_string();
        let child_abs = root.join(&child_rel);
        if depth < MAX_NESTED_REPO_DEPTH && is_nested_repo(&child_abs) {
            let before = files.len();
            scan_repo(
                &child_abs,
                &format!("{prefix}{child_rel}/"),
                depth + 1,
                files,
                repos,
            );
            if files.len() > before {
                continue;
            }
            // Child is clean, so the moved pointer IS the change. Keep the
            // row, but tag it: the path is a directory, and letting the panel
            // treat it as a file means expanding it goes looking for a blob
            // that was never there.
            row.submodule = submodule_move(&repo, &child_rel, &child_abs);
        }
        row.path = format!("{prefix}{}", row.path);
        row.repo = repo_key.clone();
        files.push(row);
    }
}

fn build_status(project_path: &str) -> StatusPayload {
    let mut files = Vec::new();
    let mut repos = Vec::new();
    scan_repo(Path::new(project_path), "", 0, &mut files, &mut repos);
    // Prefix-sorting keeps each repo's files contiguous for free.
    files.sort_by(|a, b| a.path.cmp(&b.path));

    // Counts span nested repos, so the titlebar pill agrees with the panel
    // instead of reporting one line per untouched submodule pointer.
    let (adds, dels) = files
        .iter()
        .fold((0usize, 0usize), |(a, d), row| (a + row.adds, d + row.dels));
    let summary = GitSummary {
        file_count: files.len(),
        adds,
        dels,
        branch: repos.first().and_then(|r| r.branch.clone()),
    };

    StatusPayload {
        files,
        repos,
        summary,
    }
}

#[tauri::command]
pub fn git_status(project_path: String) -> Result<StatusPayload, String> {
    Ok(build_status(&project_path))
}

/// Re-express an absolute path as repo-relative. Falls back to a canonicalised
/// compare because a workdir reached through a symlink (`/var` → `/private/var`
/// on macOS) won't prefix-match the path we built from the project root.
fn repo_relative(repo: &Repository, full: &Path, fallback: &str) -> PathBuf {
    if let Some(workdir) = repo.workdir() {
        if let Ok(rel) = full.strip_prefix(workdir) {
            return rel.to_path_buf();
        }
        if let (Ok(w), Ok(f)) = (workdir.canonicalize(), full.canonicalize()) {
            if let Ok(rel) = f.strip_prefix(&w) {
                return rel.to_path_buf();
            }
        }
    }
    PathBuf::from(fallback)
}

#[tauri::command]
pub fn git_diff_file(
    project_path: String,
    rel_path: String,
) -> Result<DiffPayload, String> {
    let full = Path::new(&project_path).join(&rel_path);

    // Open the repo that actually owns the file, not the project. A
    // submodule's blobs live in the *child's* object database, so looking
    // `backend/app/user.rb` up in the superproject's HEAD tree finds nothing
    // and the file renders as if every line were newly added.
    let repo = Repository::discover(full.parent().unwrap_or(Path::new(&project_path)))
        .or_else(|_| Repository::open(&project_path))
        .map_err(|e| e.to_string())?;
    let rel_buf = repo_relative(&repo, &full, &rel_path);
    let rel = rel_buf.as_path();

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

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A directory under the OS temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "klaudio-git-test-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Submodules are awkward to build through git2's plumbing, so the
    /// fixture uses the CLI — it also guarantees we're testing against the
    /// exact on-disk layout real projects have.
    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap_or_else(|e| panic!("git {args:?} failed to run: {e}"));
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
    }

    /// Root repo with a `backend` submodule, both with one committed file.
    fn fixture(tmp: &TempDir) -> (PathBuf, PathBuf) {
        let child = tmp.path().join("child");
        init_repo(&child);
        fs::write(child.join("a.txt"), "one\n").unwrap();
        git(&child, &["add", "."]);
        git(&child, &["commit", "-qm", "child"]);

        let root = tmp.path().join("root");
        init_repo(&root);
        fs::write(root.join("root.txt"), "root\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "root"]);
        git(
            &root,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                child.to_str().unwrap(),
                "backend",
            ],
        );
        git(&root, &["commit", "-qm", "add submodule"]);
        (root, child)
    }

    #[test]
    fn dirty_submodule_reports_its_own_files_not_the_gitlink() {
        let tmp = TempDir::new("dirty-sub");
        let (root, _) = fixture(&tmp);
        fs::write(root.join("backend/a.txt"), "two\n").unwrap();

        let payload = build_status(root.to_str().unwrap());
        let paths: Vec<&str> = payload.files.iter().map(|f| f.path.as_str()).collect();

        // The real change, attributed to the child repo...
        assert_eq!(paths, vec!["backend/a.txt"], "got {paths:?}");
        assert_eq!(payload.files[0].repo, "backend");
        assert_eq!(payload.files[0].adds, 1);
        assert_eq!(payload.files[0].dels, 1);
        // The pill folds over the same list, so it agrees with the panel.
        assert_eq!(payload.summary.file_count, 1);
        assert_eq!(payload.summary.adds, 1);
        assert_eq!(payload.summary.dels, 1);
        assert_eq!(payload.summary.branch.as_deref(), Some("main"));
        // ...and the useless `M backend +1 -1` pointer row is gone.
        assert!(!paths.contains(&"backend"));

        let repos: Vec<&str> = payload.repos.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(repos, vec!["", "backend"]);
    }

    #[test]
    fn clean_submodule_with_a_moved_pointer_keeps_the_gitlink_row() {
        let tmp = TempDir::new("moved-ptr");
        let (root, _) = fixture(&tmp);
        let sub = root.join("backend");
        fs::write(sub.join("a.txt"), "two\n").unwrap();
        git(&sub, &["commit", "-qam", "bump"]);

        let payload = build_status(root.to_str().unwrap());
        let paths: Vec<&str> = payload.files.iter().map(|f| f.path.as_str()).collect();

        // Nothing dirty inside the child, so the moved pointer IS the change
        // and dropping the row would hide it entirely.
        assert_eq!(paths, vec!["backend"], "got {paths:?}");
        assert_eq!(payload.files[0].repo, "");

        // …and it's tagged as a gitlink, because the path is a directory and
        // treating it as a file sends the panel looking for a blob that was
        // never there.
        let sub = payload.files[0]
            .submodule
            .as_ref()
            .expect("gitlink row not tagged as a submodule");
        assert!(sub.old_sha.is_some());
        assert!(sub.new_sha.is_some());
        assert_ne!(sub.old_sha, sub.new_sha);
        assert_eq!(sub.new_summary.as_deref(), Some("bump"));
    }

    #[test]
    fn a_dirty_submodules_files_are_not_tagged_as_gitlinks() {
        let tmp = TempDir::new("no-false-gitlink");
        let (root, _) = fixture(&tmp);
        fs::write(root.join("backend/a.txt"), "two\n").unwrap();

        let payload = build_status(root.to_str().unwrap());
        assert!(payload.files.iter().all(|f| f.submodule.is_none()));
    }

    #[test]
    fn diff_of_a_submodule_file_resolves_against_the_child_repo() {
        let tmp = TempDir::new("sub-diff");
        let (root, _) = fixture(&tmp);
        fs::write(root.join("backend/a.txt"), "two\n").unwrap();

        let payload =
            git_diff_file(root.to_str().unwrap().to_string(), "backend/a.txt".into()).unwrap();

        // The old side only exists in the child's object database — opening
        // the superproject would return None and render the file as new.
        assert_eq!(payload.old_contents.as_deref(), Some("one\n"));
        assert_eq!(payload.new_contents.as_deref(), Some("two\n"));
    }

    #[test]
    fn untracked_files_count_their_lines() {
        let tmp = TempDir::new("untracked");
        let root = tmp.path().join("plain");
        init_repo(&root);
        fs::write(root.join("kept.txt"), "one\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "init"]);
        fs::write(root.join("new.md"), "a\nb\nc\n").unwrap();

        let payload = build_status(root.to_str().unwrap());
        let row = payload
            .files
            .iter()
            .find(|f| f.path == "new.md")
            .expect("untracked file missing");

        // libgit2 emits the delta but not the content unless asked, which is
        // how every new file used to report `+0 -0`.
        assert!(matches!(row.kind, FileStatusKind::Untracked));
        assert_eq!(row.adds, 3);
        assert_eq!(row.dels, 0);
        assert_eq!(payload.summary.adds, 3);
    }

    #[test]
    fn plain_repo_is_unaffected() {
        let tmp = TempDir::new("plain");
        let root = tmp.path().join("plain");
        init_repo(&root);
        fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "init"]);
        fs::write(root.join("a.txt"), "two\n").unwrap();

        let payload = build_status(root.to_str().unwrap());
        assert_eq!(payload.files.len(), 1);
        assert_eq!(payload.files[0].path, "a.txt");
        assert_eq!(payload.files[0].repo, "");
        assert_eq!(payload.repos.len(), 1);
        assert_eq!(payload.repos[0].path, "");
        assert_eq!(payload.repos[0].branch.as_deref(), Some("main"));
    }
}
