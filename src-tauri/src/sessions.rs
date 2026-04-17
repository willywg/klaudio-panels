use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const SCAN_LINES_FOR_CWD: usize = 50;
const PREVIEW_MAX_CHARS: usize = 140;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub timestamp: Option<String>,
    pub first_message_preview: Option<String>,
    pub project_path: String,
}

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/projects"))
}

fn canonical(path: &str) -> String {
    PathBuf::from(path)
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

/// Scans the first N lines of a JSONL looking for a top-level `cwd` field.
fn read_cwd(file: &Path) -> Option<String> {
    let f = fs::File::open(file).ok()?;
    let reader = BufReader::new(f);
    for (i, line) in reader.lines().flatten().enumerate() {
        if i >= SCAN_LINES_FOR_CWD {
            break;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

fn extract_text_from_content(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        return Some(t.to_string());
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn is_noise_message(text: &str) -> bool {
    text.starts_with("<command-name>")
        || text.starts_with("<local-command-stdout>")
        || text.starts_with("<command-message>")
        || text.contains("Caveat: The messages below were generated")
}

fn truncate(s: &str) -> String {
    let trimmed = s.trim().replace('\n', " ");
    if trimmed.chars().count() <= PREVIEW_MAX_CHARS {
        trimmed
    } else {
        let mut out: String = trimmed.chars().take(PREVIEW_MAX_CHARS).collect();
        out.push('…');
        out
    }
}

/// Extracts the first human-authored user message + its timestamp.
fn extract_first_user_message(file: &Path) -> (Option<String>, Option<String>) {
    let Ok(f) = fs::File::open(file) else {
        return (None, None);
    };
    for line in BufReader::new(f).lines().flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let Some(content) = v.pointer("/message/content") else {
            continue;
        };
        let Some(text) = extract_text_from_content(content) else {
            continue;
        };
        if is_noise_message(&text) {
            continue;
        }
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(str::to_string);
        return (Some(truncate(&text)), ts);
    }
    (None, None)
}

#[tauri::command]
pub fn list_sessions_for_project(project_path: String) -> Result<Vec<SessionMeta>, String> {
    let projects_dir = claude_projects_dir().ok_or("cannot resolve ~/.claude/projects")?;
    if !projects_dir.exists() {
        return Ok(vec![]);
    }
    let target = canonical(&project_path);

    let mut out: Vec<SessionMeta> = Vec::new();

    // Claude encodes project dirs by replacing "/" with "-". Since that's not
    // reversible for paths containing dashes, we scan every encoded dir and
    // match against `cwd` extracted from its JSONL files.
    let entries = fs::read_dir(&projects_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        // Sample one JSONL to confirm this dir belongs to the target project.
        let sample = match fs::read_dir(&path) {
            Ok(rd) => rd
                .flatten()
                .map(|e| e.path())
                .find(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl")),
            Err(_) => None,
        };
        let Some(sample) = sample else { continue };
        let Some(cwd) = read_cwd(&sample) else { continue };
        if canonical(&cwd) != target {
            continue;
        }

        // Collect every JSONL in this dir as a session.
        if let Ok(files) = fs::read_dir(&path) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let id = match p.file_stem().and_then(|s| s.to_str()) {
                    Some(id) => id.to_string(),
                    None => continue,
                };
                let (preview, ts) = extract_first_user_message(&p);
                out.push(SessionMeta {
                    id,
                    timestamp: ts,
                    first_message_preview: preview,
                    project_path: cwd.clone(),
                });
            }
        }
    }

    // Newest first.
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

#[tauri::command]
pub fn list_session_entries(session_id: String) -> Result<Vec<Value>, String> {
    let projects_dir = claude_projects_dir().ok_or("cannot resolve ~/.claude/projects")?;
    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    // Session id is the JSONL filename (without extension) somewhere under projects/
    let target_name = format!("{session_id}.jsonl");
    let mut found: Option<PathBuf> = None;
    if let Ok(dirs) = fs::read_dir(&projects_dir) {
        for d in dirs.flatten() {
            let p = d.path().join(&target_name);
            if p.exists() {
                found = Some(p);
                break;
            }
        }
    }
    let Some(path) = found else {
        return Err(format!("session {session_id} not found"));
    };

    let f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in BufReader::new(f).lines().flatten() {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            out.push(v);
        }
    }
    Ok(out)
}
