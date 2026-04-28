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
pub(crate) fn read_cwd(file: &Path) -> Option<String> {
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

pub(crate) struct SessionScan {
    pub(crate) first_preview: Option<String>,
    pub(crate) first_timestamp: Option<String>,
    pub(crate) custom_title: Option<String>,
    pub(crate) summary: Option<String>,
    /// Set to true when the JSONL contains at least one real `user` or
    /// `assistant` turn. Used by `list_sessions_for_project` to hide ghost
    /// sessions — JSONLs that only hold a `file-history-snapshot` because
    /// the user opened a tab and never sent a prompt. Those can't be
    /// resumed (`claude --resume` replies "No conversation found").
    pub(crate) has_conversation: bool,
}

/// Single pass over the JSONL: captures first user message, custom-title and
/// summary entries. `custom-title` and `summary` are last-write-wins.
pub(crate) fn scan_session_file(file: &Path) -> SessionScan {
    let mut scan = SessionScan {
        first_preview: None,
        first_timestamp: None,
        custom_title: None,
        summary: None,
        has_conversation: false,
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
                            scan.has_conversation = true;
                        }
                    }
                }
            }
            Some("user") | Some("assistant") => {
                scan.has_conversation = true;
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

/// Result of scanning the tail of a JSONL for the most recent assistant
/// message that ended the turn. `None` means either no such message exists
/// yet or the file is unreadable. Used by `session_watcher` to fire
/// `session:complete` notifications.
#[derive(Clone, Debug)]
pub(crate) struct AssistantComplete {
    pub uuid: String,
    pub stop_reason: String,
    pub preview: Option<String>,
}

/// Walks the JSONL **from the end** looking for the most recent
/// `type: "assistant"` entry. Skips trailing `system`, `last-prompt`,
/// `permission-mode`, etc. — those are appended after the assistant
/// message and would mask the completion if we only looked at the very
/// last line. Returns the assistant entry's uuid + stop_reason + first
/// text block (truncated for notification display).
///
/// Only treats `end_turn`, `max_tokens`, `stop_sequence`, and `refusal`
/// as terminal — `tool_use` means the assistant wants to keep going
/// once the tool result comes back.
pub(crate) fn last_assistant_complete(file: &Path) -> Option<AssistantComplete> {
    const TERMINAL: &[&str] = &["end_turn", "max_tokens", "stop_sequence", "refusal"];

    let f = fs::File::open(file).ok()?;
    let lines: Vec<String> = BufReader::new(f).lines().map_while(Result::ok).collect();

    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let stop_reason = v
            .pointer("/message/stop_reason")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        if !TERMINAL.contains(&stop_reason) {
            // Most recent assistant entry is mid-tool-use; treat session
            // as still working and bail without firing.
            return None;
        }
        let uuid = v.get("uuid").and_then(|u| u.as_str())?.to_string();
        let preview = v
            .pointer("/message/content")
            .and_then(extract_text_from_content)
            .map(|s| truncate(&s));
        return Some(AssistantComplete {
            uuid,
            stop_reason: stop_reason.to_string(),
            preview,
        });
    }
    None
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
                // Hide ghost sessions — a JSONL with only a
                // file-history-snapshot line and no user/assistant turn can't
                // be resumed by `claude --resume <id>` ("No conversation
                // found with session ID..."). Treating them as non-existent
                // keeps the sidebar actionable.
                if !scan.has_conversation {
                    continue;
                }
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
