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
    pub custom_title: Option<String>,
    pub summary: Option<String>,
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
    for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
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

struct SessionScan {
    first_preview: Option<String>,
    first_timestamp: Option<String>,
    custom_title: Option<String>,
    summary: Option<String>,
}

/// Single pass over the JSONL: captures first user message, custom-title and
/// summary entries. `custom-title` and `summary` are last-write-wins.
fn scan_session_file(file: &Path) -> SessionScan {
    let mut scan = SessionScan {
        first_preview: None,
        first_timestamp: None,
        custom_title: None,
        summary: None,
    };
    let Ok(f) = fs::File::open(file) else {
        return scan;
    };
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("user") if scan.first_preview.is_none() => {
                if let Some(content) = v.pointer("/message/content") {
                    if let Some(text) = extract_text_from_content(content) {
                        if !is_noise_message(&text) {
                            scan.first_preview = Some(truncate(&text));
                            scan.first_timestamp = v
                                .get("timestamp")
                                .and_then(|t| t.as_str())
                                .map(str::to_string);
                        }
                    }
                }
            }
            Some("custom-title") => {
                if let Some(t) = v.get("customTitle").and_then(|x| x.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        scan.custom_title = Some(t.to_string());
                    }
                }
            }
            Some("summary") => {
                if let Some(s) = v.get("summary").and_then(|x| x.as_str()) {
                    let s = s.trim();
                    if !s.is_empty() {
                        scan.summary = Some(s.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    scan
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
                let scan = scan_session_file(&p);
                out.push(SessionMeta {
                    id,
                    timestamp: scan.first_timestamp,
                    first_message_preview: scan.first_preview,
                    custom_title: scan.custom_title,
                    summary: scan.summary,
                    project_path: cwd.clone(),
                });
            }
        }
    }

    // Newest first.
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}
