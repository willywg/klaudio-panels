use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::sessions::{last_assistant_complete, read_cwd, scan_session_file, SessionMeta};

const DEBOUNCE_MS: u64 = 200;

#[derive(Serialize, Clone)]
pub struct SessionNewPayload {
    pub project_path: String,
    pub session_id: String,
    pub jsonl_created_at_ms: u64,
    pub preview: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct SessionCompletePayload {
    pub project_path: String,
    pub session_id: String,
    pub stop_reason: String,
    pub preview: Option<String>,
}

static SEEN: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Last-seen completed assistant uuid per session. Used to dedupe
/// `session:complete` events — the JSONL gets multiple write ticks per
/// turn (streaming), so without this we'd fire the notification many
/// times for the same end_turn message.
static LAST_COMPLETED: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
        id: session_id.clone(),
        timestamp: scan.first_timestamp,
        first_message_preview: scan.first_preview,
        custom_title: scan.custom_title,
        summary: scan.summary,
        project_path: cwd.clone(),
    };
    let _ = app.emit("session:meta", meta);

    // Fire session:complete the first time we see a new terminal-stopped
    // assistant uuid for this session. Dedup by (session_id, uuid) so
    // multiple debouncer ticks against the same end_turn don't repeat
    // the chime + notification.
    if let Some(complete) = last_assistant_complete(path) {
        let should_emit = {
            let mut last = match LAST_COMPLETED.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match last.get(&session_id) {
                Some(prev) if *prev == complete.uuid => false,
                _ => {
                    last.insert(session_id.clone(), complete.uuid.clone());
                    true
                }
            }
        };
        if should_emit {
            let payload = SessionCompletePayload {
                project_path: cwd,
                session_id,
                stop_reason: complete.stop_reason,
                preview: complete.preview,
            };
            let _ = app.emit("session:complete", payload);
        }
    }
}

/// Scan existing JSONLs at boot so the `seen` and `last_completed` sets
/// are populated — otherwise every file already on disk would fire a
/// `session:new` on the first modification (spurious promotions) and
/// every already-finished session would fire a `session:complete`
/// notification (chime + native notif on launch for sessions that
/// completed yesterday).
fn seed_seen(root: &Path) {
    let Ok(dirs) = std::fs::read_dir(root) else { return };
    let mut seen = match SEEN.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let mut last_completed = match LAST_COMPLETED.lock() {
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
            if !is_jsonl(&fp) {
                continue;
            }
            seen.insert(fp.clone());
            if let Some(sid) = session_id_of(&fp) {
                if let Some(complete) = last_assistant_complete(&fp) {
                    last_completed.insert(sid, complete.uuid);
                }
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
