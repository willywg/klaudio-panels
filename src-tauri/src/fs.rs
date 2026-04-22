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
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FsEventPayload {
    Created { path: String, is_dir: bool },
    Modified { path: String },
    Removed { path: String },
    Renamed { from: String, to: String },
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

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut out = Vec::new();
    let walker = WalkBuilder::new(&root)
        .max_depth(Some(1))
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .parents(false)
        .build();
    for entry in walker.flatten() {
        if entry.path() == root {
            continue;
        }
        let p = entry.path().to_string_lossy().into_owned();
        let name = entry
            .file_name()
            .to_string_lossy()
            .into_owned();
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false);
        let size = if is_dir {
            None
        } else {
            entry.metadata().ok().map(|m| m.len())
        };
        out.push(FsEntry {
            path: p,
            name,
            is_dir,
            size,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
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

/// Skip hidden path components (.git, .cache, .DS_Store) and gitignored entries.
fn is_relevant(path: &Path, project_root: &Path, gi: &Gitignore) -> bool {
    let rel = match path.strip_prefix(project_root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    if rel.as_os_str().is_empty() {
        return false;
    }
    for component in rel.components() {
        if let std::path::Component::Normal(name) = component {
            if name.to_string_lossy().starts_with('.') {
                return false;
            }
        }
    }
    let is_dir = path.is_dir();
    !gi.matched(rel, is_dir).is_ignore()
}

fn event_to_payloads(event: &notify::Event) -> Vec<FsEventPayload> {
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
                        .any(|p| is_relevant(p, &root_for_handler, &gi))
                    {
                        continue;
                    }
                    for payload in event_to_payloads(&ev.event) {
                        let _ = app_for_handler
                            .emit(&format!("fs:event:{project_key}"), payload);
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
