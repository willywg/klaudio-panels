use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::sessions::{read_cwd, scan_session_file, SessionMeta};

const DEBOUNCE_MS: u64 = 200;

#[derive(Serialize, Clone)]
pub struct SessionNewPayload {
    pub project_path: String,
    pub session_id: String,
    pub jsonl_created_at_ms: u64,
    pub preview: Option<String>,
}

static SEEN: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/projects"))
}

fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e == "jsonl")
        .unwrap_or(false)
}

/// Birth time in ms since epoch. Falls back to "now" if the FS doesn't
/// support st_birthtime — we treat "we saw the file now" as the creation
/// moment, which is accurate enough for the 30s FIFO sanity guard.
fn file_birth_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
}

fn session_id_of(path: &Path) -> Option<String> {
    path.file_stem().and_then(|s| s.to_str()).map(String::from)
}

fn emit_for_jsonl(app: &AppHandle, path: &Path) {
    if !is_jsonl(path) {
        return;
    }
    // sessions.rs's read_cwd checks first N lines. If cwd isn't there yet
    // (file still being written), bail and retry on the next debounce tick.
    let Some(cwd) = read_cwd(path) else { return };
    let Some(session_id) = session_id_of(path) else { return };

    let scan = scan_session_file(path);

    // First sighting → session:new (FIFO correlation happens on the FE).
    let is_new = {
        let mut seen = match SEEN.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        seen.insert(path.to_path_buf())
    };

    if is_new {
        let payload = SessionNewPayload {
            project_path: cwd.clone(),
            session_id: session_id.clone(),
            jsonl_created_at_ms: file_birth_ms(path),
            preview: scan.first_preview.clone(),
        };
        let _ = app.emit("session:new", payload);
    }

    let meta = SessionMeta {
        id: session_id,
        timestamp: scan.first_timestamp,
        first_message_preview: scan.first_preview,
        custom_title: scan.custom_title,
        summary: scan.summary,
        project_path: cwd,
    };
    let _ = app.emit("session:meta", meta);
}

/// Scan existing JSONLs at boot so the `seen` set is populated — otherwise
/// every file already on disk would fire a session:new on the first
/// modification, flooding the FE with spurious promotions.
fn seed_seen(root: &Path) {
    let Ok(dirs) = std::fs::read_dir(root) else { return };
    let mut seen = match SEEN.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    for dir in dirs.flatten() {
        let p = dir.path();
        if !p.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&p) else { continue };
        for f in files.flatten() {
            let fp = f.path();
            if is_jsonl(&fp) {
                seen.insert(fp);
            }
        }
    }
}

/// Install the global JSONL watcher. Runs in its own OS thread; the debouncer
/// is moved into the thread and kept alive for the lifetime of the app.
pub fn install(app: AppHandle) -> anyhow::Result<()> {
    let root = claude_projects_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot resolve ~/.claude/projects"))?;
    std::fs::create_dir_all(&root)?;

    seed_seen(&root);

    let app_handler = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                for ev in events {
                    match ev.event.kind {
                        EventKind::Create(_)
                        | EventKind::Modify(_)
                        | EventKind::Remove(_) => {
                            for p in &ev.event.paths {
                                if !is_jsonl(p) {
                                    continue;
                                }
                                if matches!(ev.event.kind, EventKind::Remove(_)) {
                                    if let Ok(mut seen) = SEEN.lock() {
                                        seen.remove(p);
                                    }
                                    continue;
                                }
                                emit_for_jsonl(&app_handler, p);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Err(errors) => {
                eprintln!("session_watcher errors: {errors:?}");
            }
        },
    )?;

    debouncer.watch(&root, RecursiveMode::Recursive)?;

    // Move the debouncer into a thread and park the thread so it outlives
    // this function call.
    std::thread::spawn(move || {
        let _hold = debouncer;
        std::thread::park();
    });

    Ok(())
}
