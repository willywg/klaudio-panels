use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use lru::LruCache;
use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const WATCHER_CAPACITY: usize = 3;
const DEBOUNCE_MS: u64 = 150;

#[derive(Serialize, Clone)]
pub struct FsEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    /// Matches a gitignore rule or starts with a dot. The frontend renders
    /// these grayed + italic, and a toggle in the header hides them.
    pub ignored: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FsEventPayload {
    Created { path: String, is_dir: bool, ignored: bool },
    Modified { path: String },
    Removed { path: String },
    Renamed { from: String, to: String },
}

/// Wire format for the global `fs-event` channel. We used to emit
/// `fs:event:<project_path>` so each listener subscribed by name, but
/// Tauri v2's listen validator silently rejects names containing file-
/// system separators — the whole watch path was dead and the git panel
/// never refreshed from watcher events. Now everyone subscribes to
/// the single `fs-event` name and filters by `project_path`.
#[derive(Serialize, Clone)]
pub struct FsEventEnvelope {
    pub project_path: String,
    #[serde(flatten)]
    pub payload: FsEventPayload,
}

/// Watcher debouncer is stored as Any — we never retrieve it, we only keep it
/// alive in the LRU. Eviction drops it, which stops its internal thread.
type AnyWatcher = Box<dyn std::any::Any + Send>;

pub struct FsWatcherState {
    inner: Mutex<LruCache<String, AnyWatcher>>,
}

impl Default for FsWatcherState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(LruCache::new(
                NonZeroUsize::new(WATCHER_CAPACITY).expect("cap > 0"),
            )),
        }
    }
}

/// List a single directory level. Always returns every entry (including
/// dotfiles and gitignored ones) tagged with `ignored: bool`, except the
/// `.git` directory itself which is always hidden — its contents change
/// on every git operation and there's no realistic use case for showing
/// them in a project explorer. The frontend decides whether to render
/// ignored entries based on a user toggle.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    // Find the project root for this path so we can resolve .gitignore
    // rules correctly. For any directory, the project root is the nearest
    // ancestor that contains a .git dir, falling back to the path itself.
    let project_root = find_project_root(&root);
    let gi = build_gitignore(&project_root);

    let mut out = Vec::new();
    let walker = WalkBuilder::new(&root)
        .max_depth(Some(1))
        // Disable ignore filtering — we want every entry and we'll tag
        // them ourselves. `.git/` is still hard-skipped below.
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .parents(false)
        .build();
    for entry in walker.flatten() {
        if entry.path() == root {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let p = entry.path().to_string_lossy().into_owned();
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false);
        let size = if is_dir {
            None
        } else {
            entry.metadata().ok().map(|m| m.len())
        };
        let ignored = is_ignored(entry.path(), &project_root, &gi);
        out.push(FsEntry {
            path: p,
            name,
            is_dir,
            size,
            ignored,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// Walk upwards looking for a `.git` sibling — that's the project root.
/// Falls back to the input if nothing is found (e.g. non-repo directories).
fn find_project_root(start: &Path) -> PathBuf {
    let mut cur = start;
    loop {
        if cur.join(".git").exists() {
            return cur.to_path_buf();
        }
        match cur.parent() {
            Some(p) if p != cur => cur = p,
            _ => return start.to_path_buf(),
        }
    }
}

/// An entry is "ignored" if any path component starts with a dot, or the
/// .gitignore rules match it. Hidden and gitignored are conflated in the
/// UI — both get the grayed + italic treatment.
fn is_ignored(path: &Path, project_root: &Path, gi: &Gitignore) -> bool {
    let rel = match path.strip_prefix(project_root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    for component in rel.components() {
        if let std::path::Component::Normal(name) = component {
            if name.to_string_lossy().starts_with('.') {
                return true;
            }
        }
    }
    gi.matched(rel, path.is_dir()).is_ignore()
}

fn build_gitignore(project_root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(project_root);
    let gi = project_root.join(".gitignore");
    if gi.exists() {
        let _ = builder.add(&gi);
    }
    builder
        .build()
        .unwrap_or_else(|_| GitignoreBuilder::new(project_root).build().unwrap())
}

/// Watcher-level relevance filter. Everything outside `.git/` is a pass.
/// Inside `.git/` we keep only the files that flip when the user stages,
/// commits, switches branches or fetches (so the git pill / status panel
/// can refetch) and drop the noisy subtrees git writes on every
/// operation (object packs, reflog entries, hook scripts, etc.).
fn is_relevant(path: &Path, project_root: &Path) -> bool {
    let rel = match path.strip_prefix(project_root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    if rel.as_os_str().is_empty() {
        return false;
    }
    let mut comps = rel.components();
    let first = match comps.next() {
        Some(std::path::Component::Normal(n)) => n,
        _ => return true,
    };
    if first != ".git" {
        return true;
    }
    match comps.next() {
        // Bare `.git` (file in submodule checkouts, or dir itself) — skip.
        None => false,
        Some(std::path::Component::Normal(name)) => {
            let n = name.to_string_lossy();
            // Drop the noisy subtrees — objects / logs / hooks / info /
            // modules / lfs rewrite on every git op and would spam the
            // debouncer. Everything else inside .git/ is a potential
            // signal: HEAD / index / packed-refs / refs/** / FETCH_HEAD
            // / ORIG_HEAD / MERGE_HEAD / CHERRY_PICK_HEAD / config.
            !matches!(
                n.as_ref(),
                "objects" | "logs" | "hooks" | "info" | "modules" | "lfs"
            )
        }
        _ => false,
    }
}

fn event_to_payloads(
    event: &notify::Event,
    project_root: &Path,
    gi: &Gitignore,
) -> Vec<FsEventPayload> {
    // FSEvents on macOS coalesces rapid changes — a newly created file that's
    // written to immediately (the typical `Write` / `echo >` flow) usually
    // arrives as a single `Modify(ModifyKind::Any)` event, NOT
    // `Create(File)` + `Modify(Data)`. Relying on EventKind granularity
    // loses those creates, so we probe the filesystem instead: if the
    // path exists now → Created; otherwise → Removed. Renames with both
    // endpoints present keep their dedicated payload so the frontend
    // can preserve expanded state across the move.
    let mut payloads = Vec::new();
    match &event.kind {
        EventKind::Modify(notify::event::ModifyKind::Name(_)) if event.paths.len() == 2 => {
            payloads.push(FsEventPayload::Renamed {
                from: event.paths[0].to_string_lossy().into_owned(),
                to: event.paths[1].to_string_lossy().into_owned(),
            });
        }
        _ => {
            for p in &event.paths {
                if p.exists() {
                    payloads.push(FsEventPayload::Created {
                        path: p.to_string_lossy().into_owned(),
                        is_dir: p.is_dir(),
                        ignored: is_ignored(p, project_root, gi),
                    });
                } else {
                    payloads.push(FsEventPayload::Removed {
                        path: p.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }
    payloads
}

#[tauri::command]
pub fn watch_project(app: AppHandle, project_path: String) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }

    let state = app.state::<FsWatcherState>();
    {
        let mut cache = state.inner.lock().map_err(|e| e.to_string())?;
        if cache.contains(&project_path) {
            // Touch to MRU so switching between tracked projects keeps the LRU
            // honest.
            let _ = cache.get(&project_path);
            return Ok(());
        }
    }

    let gi = build_gitignore(&root);
    let root_for_handler = root.clone();
    let app_for_handler = app.clone();
    let project_key = project_path.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                for ev in events {
                    if !ev
                        .paths
                        .iter()
                        .any(|p| is_relevant(p, &root_for_handler))
                    {
                        continue;
                    }
                    for payload in event_to_payloads(&ev.event, &root_for_handler, &gi) {
                        let envelope = FsEventEnvelope {
                            project_path: project_key.clone(),
                            payload,
                        };
                        let _ = app_for_handler.emit("fs-event", envelope);
                    }
                }
            }
            Err(errors) => {
                eprintln!("fs watcher errors: {errors:?}");
            }
        },
    )
    .map_err(|e| format!("new_debouncer failed: {e}"))?;

    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch failed: {e}"))?;

    let mut cache = state.inner.lock().map_err(|e| e.to_string())?;
    // Eviction drops the old debouncer, which stops its thread.
    cache.put(project_path, Box::new(debouncer));
    Ok(())
}

#[tauri::command]
pub fn unwatch_project(app: AppHandle, project_path: String) -> Result<(), String> {
    let state = app.state::<FsWatcherState>();
    let mut cache = state.inner.lock().map_err(|e| e.to_string())?;
    cache.pop(&project_path);
    Ok(())
}

#[tauri::command]
pub fn fs_create_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("already exists: {path}"));
    }
    if let Some(parent) = p.parent() {
        if !parent.is_dir() {
            return Err(format!("parent directory does not exist: {}", parent.display()));
        }
    }
    std::fs::write(&p, b"").map_err(|e| format!("create file failed: {e}"))
}

#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("already exists: {path}"));
    }
    if let Some(parent) = p.parent() {
        if !parent.is_dir() {
            return Err(format!("parent directory does not exist: {}", parent.display()));
        }
    }
    std::fs::create_dir(&p).map_err(|e| format!("create dir failed: {e}"))
}

#[tauri::command]
pub fn fs_delete(path: String, is_dir: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("does not exist: {path}"));
    }
    if is_dir {
        std::fs::remove_dir_all(&p).map_err(|e| format!("remove dir failed: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("remove file failed: {e}"))
    }
}
