use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use git2::{
    BranchType, Commit, Delta, Diff, DiffOptions, Oid, Repository, Sort, Status, StatusOptions,
    Tree,
};
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

/// One row per delta, with `+`/`−` counts summed from the line callback.
///
/// Shared by the working-tree status and a commit's file list: the two differ
/// only in which trees the diff was built from, and in whether `staged` means
/// anything (for a commit it does not, and the caller passes a closure saying
/// so). A second copy of this accounting is how the two views would drift into
/// disagreeing about the same file.
fn files_from_diff(
    diff: &Diff<'_>,
    staged_for: &dyn Fn(&str) -> bool,
) -> Result<Vec<FileStatus>, String> {
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
            let staged = staged_for(&path);
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

    files_from_diff(&diff, &|path| {
        flags_by_path
            .get(path)
            .map(|f| {
                f.intersects(
                    Status::INDEX_NEW
                        | Status::INDEX_MODIFIED
                        | Status::INDEX_DELETED
                        | Status::INDEX_RENAMED
                        | Status::INDEX_TYPECHANGE,
                )
            })
            .unwrap_or(false)
    })
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

/// One side of a diff, from its raw bytes: the text, or why there isn't any.
/// `None` bytes mean the side doesn't exist — the file was added, or deleted.
fn diff_side(bytes: Option<Vec<u8>>) -> DiffSide {
    match bytes {
        None => DiffSide::default(),
        Some(b) if b.len() > MAX_DIFF_BYTES => DiffSide {
            too_large: true,
            ..DiffSide::default()
        },
        Some(b) if is_binary_bytes(&b) => DiffSide {
            is_binary: true,
            ..DiffSide::default()
        },
        Some(b) => DiffSide {
            contents: Some(String::from_utf8_lossy(&b).into_owned()),
            ..DiffSide::default()
        },
    }
}

#[derive(Default)]
struct DiffSide {
    contents: Option<String>,
    is_binary: bool,
    too_large: bool,
}

fn payload(path: String, old: DiffSide, new: DiffSide) -> DiffPayload {
    DiffPayload {
        path,
        old_contents: old.contents,
        new_contents: new.contents,
        is_binary: old.is_binary || new.is_binary,
        too_large: old.too_large || new.too_large,
    }
}

/// A file's bytes as of some tree, or `None` when the tree doesn't have it.
fn tree_blob(repo: &Repository, tree: Option<&Tree<'_>>, path: &Path) -> Option<Vec<u8>> {
    tree?
        .get_path(path)
        .ok()
        .and_then(|entry| entry.to_object(repo).ok())
        .and_then(|obj| obj.into_blob().ok())
        .map(|blob| blob.content().to_vec())
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
    let new_side = diff_side(std::fs::read(&full).ok());
    // HEAD side — may be absent on a fresh repo or for untracked files.
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let old_side = diff_side(tree_blob(&repo, head_tree.as_ref(), rel));

    Ok(payload(rel_path, old_side, new_side))
}

/// One commit in the history list.
#[derive(Debug, Serialize, Clone)]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    /// Committer time as Unix seconds. Formatting is the frontend's job —
    /// it already renders relative times for sessions.
    pub timestamp: i64,
    /// Not yet on the branch's upstream. Always false when there is no
    /// upstream to compare against, since then nothing is knowably pushed.
    pub unpushed: bool,
    /// A merge has more than one parent; the diff we show is against the
    /// first, so the panel can say as much rather than quietly picking.
    pub parent_count: usize,
    /// `files_changed / +/ −` against the first parent, or `None` for a
    /// merge. `git log --stat` leaves merges out for the same reason: the
    /// first-parent diff of a merge restates every commit it brought in, so
    /// the number describes the branch, not the merge.
    pub stats: Option<CommitStats>,
}

#[derive(Debug, Serialize, Clone, Copy)]
pub struct CommitStats {
    pub files: usize,
    pub adds: usize,
    pub dels: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct HistoryPayload {
    pub commits: Vec<CommitInfo>,
    pub branch: Option<String>,
    /// Commits ahead of upstream, or `None` when there is no upstream — a
    /// local-only branch, or a detached HEAD.
    pub ahead: Option<usize>,
    /// Another page exists past what was returned.
    pub has_more: bool,
}

/// A commit's message and the files it touched.
#[derive(Debug, Serialize, Clone)]
pub struct CommitDetail {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    /// Message past the subject line, trimmed. Empty when there is none.
    pub body: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub parent_count: usize,
    pub files: Vec<FileStatus>,
    pub adds: usize,
    pub dels: usize,
}

/// Largest page `git_history` will hand back in one call. The list is
/// virtual-scroll-free and every row costs a `find_commit`, so a caller
/// asking for ten thousand gets clamped rather than obeyed.
const MAX_HISTORY_PAGE: usize = 200;

/// How far back we bother resolving "is this pushed yet?". A branch that has
/// drifted this far from its remote is past the point where marking each row
/// individually tells you anything; the `ahead` count still does.
const MAX_UNPUSHED_SCAN: usize = 1000;

fn short_sha(sha: &str) -> String {
    sha[..7.min(sha.len())].to_string()
}

/// The upstream's tip, or `None` when the branch has none — a local-only
/// branch or a detached HEAD, both of which have nothing to be "ahead" of.
fn upstream_oid(repo: &Repository) -> Option<Oid> {
    if repo.head_detached().unwrap_or(false) {
        return None;
    }
    let head = repo.head().ok()?;
    let name = head.shorthand()?;
    let branch = repo.find_branch(name, BranchType::Local).ok()?;
    branch.upstream().ok()?.get().target()
}

/// Commits on HEAD the upstream doesn't have yet, plus how many there are.
///
/// The set is walked rather than inferred from the count: `ahead` alone would
/// only identify the unpushed commits on a linear branch, and merging the
/// remote in is exactly when you most want to know what is still local.
fn unpushed_set(repo: &Repository, head_oid: Oid) -> (HashSet<Oid>, Option<usize>) {
    let Some(upstream) = upstream_oid(repo) else {
        return (HashSet::new(), None);
    };
    let ahead = repo
        .graph_ahead_behind(head_oid, upstream)
        .ok()
        .map(|(a, _)| a);
    let mut set = HashSet::new();
    if let Ok(mut walk) = repo.revwalk() {
        if walk.push(head_oid).is_ok() && walk.hide(upstream).is_ok() {
            for oid in walk.take(MAX_UNPUSHED_SCAN).flatten() {
                set.insert(oid);
            }
        }
    }
    (set, ahead)
}

/// Resolve a full or abbreviated sha to a commit.
///
/// Deliberately not `revparse_single`: that accepts a whole revspec grammar
/// (`HEAD~3`, `:/subject`, `branch@{yesterday}`), and the only thing that
/// should ever reach here is an id this module handed the frontend. Rejecting
/// anything non-hex keeps the command's input surface to exactly that.
fn find_commit<'r>(repo: &'r Repository, sha: &str) -> Result<Commit<'r>, String> {
    if sha.len() < 4 || sha.len() > 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid commit id".to_string());
    }
    let obj = repo
        .revparse_single(sha)
        .map_err(|_| "no such commit".to_string())?;
    obj.peel_to_commit()
        .map_err(|_| "not a commit".to_string())
}

/// Totals for a commit against its first parent. `None` for a merge.
///
/// One `diff_tree_to_tree` per row: the same work `git log --stat` does, and
/// bounded by the page size the caller is already clamped to.
fn commit_stats(repo: &Repository, commit: &Commit<'_>) -> Option<CommitStats> {
    if commit.parent_count() > 1 {
        return None;
    }
    let new_tree = commit.tree().ok()?;
    let old_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    opts.context_lines(0);
    let diff = repo
        .diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut opts))
        .ok()?;
    let stats = diff.stats().ok()?;
    Some(CommitStats {
        files: stats.files_changed(),
        adds: stats.insertions(),
        dels: stats.deletions(),
    })
}

/// The trees a commit is shown as the difference between.
///
/// A merge is diffed against its **first parent** — what `git show` does, and
/// the only choice that makes "what did this commit change" answerable at all
/// (against all parents, everything looks unchanged on one side or the other).
/// A root commit has no parent, so every line in it is new.
fn commit_trees<'r>(
    commit: &Commit<'r>,
) -> Result<(Option<Tree<'r>>, Tree<'r>), String> {
    let new_tree = commit.tree().map_err(|e| e.to_string())?;
    let old_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    Ok((old_tree, new_tree))
}

/// Commits reachable from HEAD, newest first, one page at a time.
///
/// The project's **own** repo only. A nested repo's history is its own
/// project's to show, and `git_status`' habit of descending into submodules
/// would produce a single list interleaving two unrelated histories.
#[tauri::command]
pub fn git_history(
    project_path: String,
    skip: usize,
    limit: usize,
) -> Result<HistoryPayload, String> {
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let branch = head_label(&repo);

    // A repo with no commits yet has a HEAD that resolves to nothing. That's
    // an empty history, not a failure — `git log` says the same thing.
    let Some(head_oid) = repo.head().ok().and_then(|h| h.target()) else {
        return Ok(HistoryPayload {
            commits: Vec::new(),
            branch,
            ahead: None,
            has_more: false,
        });
    };

    let (unpushed, ahead) = unpushed_set(&repo, head_oid);
    let limit = limit.clamp(1, MAX_HISTORY_PAGE);

    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(|e| e.to_string())?;
    walk.push(head_oid).map_err(|e| e.to_string())?;

    let mut commits = Vec::with_capacity(limit);
    let mut has_more = false;
    for oid in walk.skip(skip).flatten() {
        // Read one past the page so "load more" knows whether to offer
        // itself, without a second walk to count the rest.
        if commits.len() == limit {
            has_more = true;
            break;
        }
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let sha = oid.to_string();
        commits.push(CommitInfo {
            short_sha: short_sha(&sha),
            sha,
            subject: commit.summary().unwrap_or_default().to_string(),
            author: commit
                .author()
                .name()
                .unwrap_or_default()
                .to_string(),
            timestamp: commit.time().seconds(),
            unpushed: unpushed.contains(&oid),
            parent_count: commit.parent_count(),
            stats: commit_stats(&repo, &commit),
        });
    }

    Ok(HistoryPayload {
        commits,
        branch,
        ahead,
        has_more,
    })
}

/// A commit's message plus the files it touched, with per-file `+`/`−`.
#[tauri::command]
pub fn git_commit_detail(
    project_path: String,
    sha: String,
) -> Result<CommitDetail, String> {
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let commit = find_commit(&repo, &sha)?;
    let (old_tree, new_tree) = commit_trees(&commit)?;

    let mut opts = DiffOptions::new();
    opts.context_lines(0);
    let diff = repo
        .diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut opts))
        .map_err(|e| e.to_string())?;
    // `staged` has no meaning for a commit: everything in it is committed.
    let files = files_from_diff(&diff, &|_| false)?;
    let (adds, dels) = files
        .iter()
        .fold((0usize, 0usize), |(a, d), f| (a + f.adds, d + f.dels));

    let full = commit.id().to_string();
    let message = commit.message().unwrap_or_default();
    let subject = commit.summary().unwrap_or_default().to_string();
    let body = message
        .strip_prefix(&subject)
        .unwrap_or("")
        .trim()
        .to_string();

    // Bound before the struct literal: a `Signature` borrows the commit, and
    // as a temporary in the tail expression it would outlive it.
    let author = commit.author();
    let name = author.name().unwrap_or_default().to_string();
    let email = author.email().unwrap_or_default().to_string();

    Ok(CommitDetail {
        short_sha: short_sha(&full),
        sha: full,
        subject,
        body,
        author: name,
        email,
        timestamp: commit.time().seconds(),
        parent_count: commit.parent_count(),
        files,
        adds,
        dels,
    })
}

/// One file as the commit changed it: the parent's blob against the commit's.
///
/// Same `DiffPayload` the working-tree view renders, so the panel draws a
/// historical diff through exactly the same path as a live one.
#[tauri::command]
pub fn git_diff_commit_file(
    project_path: String,
    sha: String,
    rel_path: String,
) -> Result<DiffPayload, String> {
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let commit = find_commit(&repo, &sha)?;
    let (old_tree, new_tree) = commit_trees(&commit)?;
    let rel = Path::new(&rel_path);

    let old_side = diff_side(tree_blob(&repo, old_tree.as_ref(), rel));
    let new_side = diff_side(tree_blob(&repo, Some(&new_tree), rel));

    Ok(payload(rel_path, old_side, new_side))
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

    /// A repo with `n` commits, each adding one line to `f.txt`.
    fn linear_repo(tmp: &TempDir, label: &str, n: usize) -> PathBuf {
        let root = tmp.path().join(label);
        init_repo(&root);
        let mut body = String::new();
        for i in 0..n {
            body.push_str(&format!("line {i}\n"));
            fs::write(root.join("f.txt"), &body).unwrap();
            git(&root, &["add", "."]);
            git(&root, &["commit", "-qm", &format!("commit {i}")]);
        }
        root
    }

    fn history(root: &Path, skip: usize, limit: usize) -> HistoryPayload {
        git_history(root.to_str().unwrap().to_string(), skip, limit).unwrap()
    }

    #[test]
    fn history_lists_commits_newest_first() {
        let tmp = TempDir::new("history");
        let root = linear_repo(&tmp, "r", 3);

        let payload = history(&root, 0, 10);
        let subjects: Vec<&str> = payload.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["commit 2", "commit 1", "commit 0"]);
        assert_eq!(payload.branch.as_deref(), Some("main"));
        assert!(!payload.has_more);
        assert_eq!(payload.commits[0].short_sha.len(), 7);
        assert_eq!(payload.commits[0].parent_count, 1);
        let stats = payload.commits[0].stats.expect("a plain commit has stats");
        assert_eq!((stats.files, stats.adds, stats.dels), (1, 1, 0));
        // No remote configured, so "pushed" is not a question we can answer.
        assert_eq!(payload.ahead, None);
        assert!(payload.commits.iter().all(|c| !c.unpushed));
    }

    #[test]
    fn history_pages_and_says_when_more_is_left() {
        let tmp = TempDir::new("history-page");
        let root = linear_repo(&tmp, "r", 5);

        let first = history(&root, 0, 2);
        assert_eq!(first.commits.len(), 2);
        assert!(first.has_more, "more commits exist past the first page");

        let second = history(&root, 2, 2);
        assert_eq!(
            second.commits[0].subject, "commit 2",
            "the second page continues where the first stopped"
        );

        let last = history(&root, 4, 2);
        assert_eq!(last.commits.len(), 1);
        assert!(!last.has_more, "the final page must not offer another");
    }

    #[test]
    fn an_empty_repo_has_an_empty_history_rather_than_an_error() {
        let tmp = TempDir::new("history-empty");
        let root = tmp.path().join("fresh");
        init_repo(&root);

        // HEAD exists as a symref pointing at nothing. `git log` calls this
        // an empty history, and so do we — a hard error would make the panel
        // look broken on a repo the user just created.
        let payload = history(&root, 0, 10);
        assert!(payload.commits.is_empty());
        assert!(!payload.has_more);
    }

    #[test]
    fn commits_above_the_upstream_are_marked_unpushed() {
        let tmp = TempDir::new("history-ahead");
        let root = linear_repo(&tmp, "r", 2);
        let bare = tmp.path().join("origin.git");
        fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare"]);
        git(&root, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&root, &["push", "-q", "-u", "origin", "main"]);

        fs::write(root.join("g.txt"), "new\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "after push"]);

        let payload = history(&root, 0, 10);
        assert_eq!(payload.ahead, Some(1));
        // Exactly the one commit made after the push, and not the ones the
        // remote already has.
        let unpushed: Vec<&str> = payload
            .commits
            .iter()
            .filter(|c| c.unpushed)
            .map(|c| c.subject.as_str())
            .collect();
        assert_eq!(unpushed, vec!["after push"]);
    }

    #[test]
    fn commit_detail_reports_the_files_that_commit_touched() {
        let tmp = TempDir::new("detail");
        let root = linear_repo(&tmp, "r", 1);
        fs::write(root.join("added.txt"), "a\nb\n").unwrap();
        fs::write(root.join("f.txt"), "changed\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "subject line\n\nbody line one\nbody line two"]);

        let head = history(&root, 0, 1).commits[0].sha.clone();
        let detail =
            git_commit_detail(root.to_str().unwrap().to_string(), head.clone()).unwrap();

        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["added.txt", "f.txt"]);
        assert_eq!(detail.subject, "subject line");
        assert_eq!(detail.body, "body line one\nbody line two");
        assert_eq!(detail.sha, head);
        // +2 for the new file, +1/−1 for the rewritten one.
        assert_eq!(detail.adds, 3);
        assert_eq!(detail.dels, 1);
        // Nothing in a commit is "staged" — it is already in.
        assert!(detail.files.iter().all(|f| !f.staged));
    }

    #[test]
    fn a_merge_is_shown_against_its_first_parent() {
        let tmp = TempDir::new("merge");
        let root = linear_repo(&tmp, "r", 1);
        git(&root, &["checkout", "-q", "-b", "side"]);
        fs::write(root.join("side.txt"), "s\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "side work"]);
        git(&root, &["checkout", "-q", "main"]);
        fs::write(root.join("main.txt"), "m\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "main work"]);
        git(&root, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);

        let head = history(&root, 0, 1).commits[0].sha.clone();
        assert_eq!(
            history(&root, 0, 1).commits[0].parent_count,
            2,
            "the panel needs to know this is a merge"
        );
        assert!(
            history(&root, 0, 1).commits[0].stats.is_none(),
            "a merge's first-parent stats restate the branch, so we don't show them"
        );
        let detail = git_commit_detail(root.to_str().unwrap().to_string(), head).unwrap();
        // Against the first parent (main), the merge brings in side's file
        // and nothing else. Against the second it would look empty.
        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["side.txt"]);
    }

    #[test]
    fn a_commits_file_diff_uses_the_parent_as_the_old_side() {
        let tmp = TempDir::new("commit-diff");
        let root = linear_repo(&tmp, "r", 2);
        let head = history(&root, 0, 1).commits[0].sha.clone();

        let payload = git_diff_commit_file(
            root.to_str().unwrap().to_string(),
            head,
            "f.txt".to_string(),
        )
        .unwrap();
        assert_eq!(payload.old_contents.as_deref(), Some("line 0\n"));
        assert_eq!(payload.new_contents.as_deref(), Some("line 0\nline 1\n"));
        assert!(!payload.is_binary);
        assert!(!payload.too_large);
    }

    #[test]
    fn a_root_commit_has_no_old_side() {
        let tmp = TempDir::new("root-commit");
        let root = linear_repo(&tmp, "r", 1);
        let first = history(&root, 0, 10).commits.pop().unwrap();

        let payload = git_diff_commit_file(
            root.to_str().unwrap().to_string(),
            first.sha,
            "f.txt".to_string(),
        )
        .unwrap();
        // No parent, so every line is new — the panel renders it all-added
        // rather than showing a blank diff.
        assert_eq!(payload.old_contents, None);
        assert_eq!(payload.new_contents.as_deref(), Some("line 0\n"));
    }

    #[test]
    fn only_a_hex_object_id_is_accepted_as_a_commit() {
        let tmp = TempDir::new("revspec");
        let root = linear_repo(&tmp, "r", 2);
        let path = root.to_str().unwrap().to_string();

        // git's revspec grammar would happily resolve all of these. The
        // command's input is an id this module handed out, so anything else
        // is refused rather than interpreted.
        for bad in ["HEAD", "HEAD~1", "main", ":/commit", "", "zzzzzzz"] {
            assert!(
                git_commit_detail(path.clone(), bad.to_string()).is_err(),
                "{bad:?} should not resolve to a commit"
            );
        }

        // An abbreviated id still works — it is hex, and it is ours.
        let head = history(&root, 0, 1).commits[0].short_sha.clone();
        assert!(git_commit_detail(path, head).is_ok());
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
