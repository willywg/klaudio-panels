use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const SCAN_LINES_FOR_CWD: usize = 50;
const PREVIEW_MAX_CHARS: usize = 140;

// Only the tail can hold "the most recent event", so every recency-related
// scan (completion detection, `updated_at`) caps its read here — collecting
// a multi-hundred-MB session (#60) into memory on every watcher tick was
// pure churn. 4 MiB comfortably covers even an enormous assistant message
// plus the trailing system/bookkeeping entries.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    /// First real user message's timestamp. Never recomputed from later
    /// activity — see `updated_at` for recency.
    pub created_at: Option<String>,
    /// Most recent meaningful activity: the latest valid timestamp found in
    /// the JSONL tail, falling back to the file's mtime. This — not
    /// `created_at` — is what the session list sorts by.
    pub updated_at: Option<String>,
    pub first_message_preview: Option<String>,
    pub custom_title: Option<String>,
    pub summary: Option<String>,
    pub project_path: String,
}

/// Parses a Claude-written timestamp as RFC 3339, normalized to UTC.
fn parse_rfc3339(ts: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Re-serializes `ts` in one canonical UTC shape (fixed millisecond
/// precision, `Z` suffix) so every `created_at`/`updated_at` value sorts
/// correctly as a plain string and compares correctly once re-parsed —
/// regardless of the offset or fractional-second precision the source line
/// happened to use. A value that fails to parse is passed through as-is
/// rather than discarded; it just won't participate meaningfully in sorting
/// (see `ts_key`).
pub(crate) fn canonicalize_rfc3339(ts: &str) -> String {
    parse_rfc3339(ts)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| ts.to_string())
}

/// Sort key for a `created_at`/`updated_at` field: parses it back to a
/// `DateTime<Utc>` so ordering is chronological, never lexicographic on the
/// raw string (differing offsets or fractional-second widths would otherwise
/// sort wrong). Missing or unparseable values sort last, same as before.
fn ts_key(v: &Option<String>) -> Option<DateTime<Utc>> {
    v.as_deref().and_then(parse_rfc3339)
}

/// Resolve the Claude sessions directory: `<config_dir>/projects` when the
/// project's direnv (see `project_env.rs`) set a `CLAUDE_CONFIG_DIR`,
/// otherwise the default `~/.claude/projects`.
fn projects_dir_for(config_dir: Option<PathBuf>) -> Option<PathBuf> {
    match config_dir {
        Some(dir) => Some(dir.join("projects")),
        None => dirs::home_dir().map(|h| h.join(".claude/projects")),
    }
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

/// Cheap substring gate that runs before the expensive `serde_json` parse
/// in `scan_session_file`. Session files reach hundreds of MB (#60) and
/// most of that bulk is giant user/assistant lines (tool results, pasted
/// dumps) that stop mattering once the preview is settled — only
/// `custom-title` / `summary` rewrites do. A false positive (the word
/// appearing inside message content) just costs one parse that the type
/// match then discards; a false negative can't happen for well-formed
/// entries because the JSON type value is always a substring of its line.
fn line_may_matter(line: &str, need_conversation_info: bool) -> bool {
    if line.contains("custom-title") || line.contains("\"summary\"") {
        return true;
    }
    need_conversation_info && (line.contains("\"user\"") || line.contains("\"assistant\""))
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
        let need_conv = scan.first_preview.is_none() || !scan.has_conversation;
        if !line_may_matter(&line, need_conv) {
            continue;
        }
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

/// Reads the last `TAIL_BYTES` of a JSONL and returns its lines in file
/// order. Shared by every "what happened most recently" query —
/// `last_assistant_complete_from_tail` and `latest_event_timestamp_from_tail`
/// both only care about the tail, so a caller that needs both (see
/// `session_watcher::emit_for_jsonl`) reads the file once and passes the
/// same `lines` to each, instead of every helper doing its own read.
pub(crate) fn read_tail_lines(file: &Path) -> Option<Vec<String>> {
    let mut f = fs::File::open(file).ok()?;
    let len = f.metadata().ok()?.len();
    let clipped = len > TAIL_BYTES;
    if clipped {
        f.seek(SeekFrom::End(-(TAIL_BYTES as i64))).ok()?;
    }
    let mut lines: Vec<String> = BufReader::new(f).lines().map_while(Result::ok).collect();
    if clipped && !lines.is_empty() {
        // The seek almost certainly landed mid-line; the partial first row
        // would fail to parse anyway, but drop it explicitly.
        lines.remove(0);
    }
    Some(lines)
}

/// Walks already-read tail `lines` **from the end** looking for the most
/// recent `type: "assistant"` entry. Skips trailing `system`, `last-prompt`,
/// `permission-mode`, etc. — those are appended after the assistant
/// message and would mask the completion if we only looked at the very
/// last line. Returns the assistant entry's uuid + stop_reason + first
/// text block (truncated for notification display).
///
/// Only treats `end_turn`, `max_tokens`, `stop_sequence`, and `refusal`
/// as terminal — `tool_use` means the assistant wants to keep going
/// once the tool result comes back.
pub(crate) fn last_assistant_complete_from_tail(lines: &[String]) -> Option<AssistantComplete> {
    const TERMINAL: &[&str] = &["end_turn", "max_tokens", "stop_sequence", "refusal"];

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

/// Convenience wrapper for call sites that only need the completion fact
/// (e.g. `session_watcher::seed_seen`, which doesn't need `updated_at` too
/// and so has no reason to hold onto the tail lines itself).
pub(crate) fn last_assistant_complete(file: &Path) -> Option<AssistantComplete> {
    last_assistant_complete_from_tail(&read_tail_lines(file)?)
}

/// Walks already-read tail `lines` **from the end** looking for the newest
/// one that carries a top-level `timestamp` field. Lines with no such field
/// at all — `last-prompt` and other trailing bookkeeping records — are
/// skipped in search of an earlier, real event. But once a timestamp-bearing
/// line is found, a malformed value stops the search immediately rather than
/// falling through to a possibly much older valid timestamp further back:
/// callers fall back to the file's mtime in that case, which is a more
/// honest "we don't know" than silently understating how recent the session
/// actually is.
fn latest_event_timestamp_from_tail(lines: &[String]) -> Option<DateTime<Utc>> {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) else {
            continue;
        };
        return parse_rfc3339(ts);
    }
    None
}

fn mtime_utc(file: &Path) -> Option<DateTime<Utc>> {
    let modified = fs::metadata(file).ok()?.modified().ok()?;
    Some(modified.into())
}

/// Canonical `updated_at` for a session: the latest valid timestamp in
/// `lines` (see `latest_event_timestamp_from_tail`), falling back to the
/// file's own mtime — both normalized through `canonicalize_rfc3339`'s
/// format so recency comparisons never depend on differing offsets or
/// fractional-second precision.
pub(crate) fn session_updated_at(file: &Path, lines: &[String]) -> Option<String> {
    latest_event_timestamp_from_tail(lines)
        .or_else(|| mtime_utc(file))
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Async so Tauri dispatches it off the main thread — as a sync command
/// this ran ON the main thread and a project with hundreds of MB of
/// session JSONLs froze the whole UI for minutes (#60). `spawn_blocking`
/// keeps the CPU-bound scan off the async runtime's core threads too.
#[tauri::command]
pub async fn list_sessions_for_project(
    project_path: String,
) -> Result<Vec<SessionMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || list_sessions_for_project_sync(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn list_sessions_for_project_sync(project_path: String) -> Result<Vec<SessionMeta>, String> {
    // Fails closed on a direnv evaluation error (see project_env.rs) — we
    // never fall back to the default ~/.claude/projects after a failure,
    // since that could show sessions from the wrong Claude account.
    let config_dir = crate::project_env::resolve_claude_config_dir(&project_path)?;
    let projects_dir =
        projects_dir_for(config_dir).ok_or("cannot resolve Claude sessions directory")?;
    if !projects_dir.exists() {
        return Ok(vec![]);
    }
    Ok(scan_projects_dir(&projects_dir, &project_path))
}

/// Scans every encoded project dir under `projects_dir` for sessions whose
/// recorded `cwd` matches `project_path`, sorted by recency (see the
/// `sort_by` below). Pure and side-effect-free beyond reading
/// `projects_dir`, so it's the unit under test for both the recency
/// ordering and config-root scoping (see `tests::` below) — `projects_dir`
/// is whatever `list_sessions_for_project` already resolved (custom
/// `CLAUDE_CONFIG_DIR/projects` or the default `~/.claude/projects`), never
/// both, so a caller that passes the wrong root is the only way this can
/// leak sessions across profiles.
fn scan_projects_dir(projects_dir: &Path, project_path: &str) -> Vec<SessionMeta> {
    let target = canonical(project_path);

    let mut out: Vec<SessionMeta> = Vec::new();

    // Claude encodes project dirs by replacing "/" with "-". Since that's not
    // reversible for paths containing dashes, we scan every encoded dir and
    // match against `cwd` extracted from its JSONL files.
    let Ok(entries) = fs::read_dir(projects_dir) else {
        return out;
    };
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
                // One bounded tail read feeds `updated_at` here; nothing else
                // in this loop needs the tail, so there's no second helper to
                // share it with (contrast `session_watcher::emit_for_jsonl`,
                // which also needs `last_assistant_complete_from_tail`).
                let tail_lines = read_tail_lines(&p).unwrap_or_default();
                out.push(SessionMeta {
                    id,
                    created_at: scan.first_timestamp.map(|ts| canonicalize_rfc3339(&ts)),
                    updated_at: session_updated_at(&p, &tail_lines),
                    first_message_preview: scan.first_preview,
                    custom_title: scan.custom_title,
                    summary: scan.summary,
                    project_path: cwd.clone(),
                });
            }
        }
    }

    // Recency first: updated_at descending, then created_at descending, then
    // session id ascending as a deterministic final tie-breaker (so two
    // sessions with identical updated_at/created_at don't flip order between
    // runs depending on directory-read order).
    out.sort_by(|a, b| {
        ts_key(&b.updated_at)
            .cmp(&ts_key(&a.updated_at))
            .then_with(|| ts_key(&b.created_at).cmp(&ts_key(&a.created_at)))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;
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
                "klaudio-sessions-test-{label}-{}-{nanos}",
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

    /// Same fake-direnv technique as `project_env::tests` — a shell script
    /// whose stdout is controlled via `FAKE_DIRENV_STDOUT`.
    fn write_fake_direnv(bin_dir: &Path) {
        let script = "#!/bin/sh\n\
             if [ -n \"$FAKE_DIRENV_STDOUT\" ]; then printf '%s' \"$FAKE_DIRENV_STDOUT\"; fi\n\
             exit 0\n";
        let path = bin_dir.join("direnv");
        fs::write(&path, script).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
    }

    /// Encodes a project path the way Claude does: "/" -> "-".
    fn encode(path: &str) -> String {
        path.replace('/', "-")
    }

    /// Writes a minimal single-line JSONL that `scan_session_file` will
    /// recognize as a real (resumable) session with the given `cwd` and
    /// first-user `timestamp` (becomes `created_at`).
    fn write_session_jsonl(project_dir: &Path, id: &str, cwd: &str, message: &str, timestamp: &str) {
        fs::create_dir_all(project_dir).unwrap();
        let escaped_cwd = cwd.replace('\\', "\\\\").replace('"', "\\\"");
        let escaped_msg = message.replace('\\', "\\\\").replace('"', "\\\"");
        let line = format!(
            r#"{{"type":"user","cwd":"{escaped_cwd}","timestamp":"{timestamp}","message":{{"role":"user","content":"{escaped_msg}"}}}}"#
        );
        fs::write(project_dir.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();
    }

    /// Writes a minimal single-line JSONL with **no** top-level `timestamp`
    /// field at all — simulates a malformed/legacy entry so `created_at` and
    /// the tail scan both have nothing to find.
    fn write_session_jsonl_without_timestamp(project_dir: &Path, id: &str, cwd: &str, message: &str) {
        fs::create_dir_all(project_dir).unwrap();
        let escaped_cwd = cwd.replace('\\', "\\\\").replace('"', "\\\"");
        let escaped_msg = message.replace('\\', "\\\\").replace('"', "\\\"");
        let line = format!(
            r#"{{"type":"user","cwd":"{escaped_cwd}","message":{{"role":"user","content":"{escaped_msg}"}}}}"#
        );
        fs::write(project_dir.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();
    }

    /// Appends a raw JSONL line to a session file already created by
    /// `write_session_jsonl` — simulates later activity (e.g. a resumed
    /// session picking up a fresh turn) without touching the first line's
    /// `created_at`.
    fn append_jsonl_line(project_dir: &Path, id: &str, line: &str) {
        use std::io::Write as _;
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(project_dir.join(format!("{id}.jsonl")))
            .unwrap();
        writeln!(f, "{line}").unwrap();
    }

    /// Asserts `ts` parses as RFC 3339 and lands within `tolerance_secs` of
    /// now — used to check an mtime-derived `updated_at` without depending
    /// on exact timing.
    fn assert_close_to_now(ts: &str, tolerance_secs: i64) {
        let parsed = DateTime::parse_from_rfc3339(ts)
            .expect("mtime fallback must still be a valid RFC 3339 timestamp")
            .with_timezone(&Utc);
        let delta = (Utc::now() - parsed).num_seconds().abs();
        assert!(
            delta <= tolerance_secs,
            "expected {ts} to be within {tolerance_secs}s of now, delta={delta}s"
        );
    }

    #[test]
    fn resumed_old_session_with_recent_activity_sorts_above_inactive_newer_session() {
        let root = TempDir::new("projects-root-recency");
        let project = TempDir::new("project-recency");
        let project_path = project.path().to_str().unwrap().to_string();
        let project_dir = root.path().join(encode(&project_path));

        // Created in 2020, but a later turn was recorded far more recently —
        // e.g. resumed today and used again, exactly the reported bug.
        write_session_jsonl(
            &project_dir,
            "old-but-active",
            &project_path,
            "hi",
            "2020-01-01T00:00:00.000Z",
        );
        append_jsonl_line(
            &project_dir,
            "old-but-active",
            r#"{"type":"assistant","timestamp":"2026-07-21T11:00:00.000Z","message":{"role":"assistant","content":"still here"}}"#,
        );

        // Created more recently than the session above, but never touched
        // again — its only timestamp is its own creation.
        write_session_jsonl(
            &project_dir,
            "new-but-inactive",
            &project_path,
            "hi",
            "2025-06-01T00:00:00.000Z",
        );

        let sessions = scan_projects_dir(root.path(), &project_path);

        assert_eq!(
            sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["old-but-active", "new-but-inactive"],
            "recent activity must outrank a newer but stale creation time"
        );
        assert_eq!(
            sessions[0].updated_at.as_deref(),
            Some("2026-07-21T11:00:00.000Z")
        );
        assert_eq!(
            sessions[0].created_at.as_deref(),
            Some("2020-01-01T00:00:00.000Z"),
            "created_at must still reflect the first user message, not the later activity"
        );
    }

    #[test]
    fn created_at_is_never_overwritten_by_later_activity() {
        let root = TempDir::new("projects-root-created-at");
        let project = TempDir::new("project-created-at");
        let project_path = project.path().to_str().unwrap().to_string();
        let project_dir = root.path().join(encode(&project_path));

        write_session_jsonl(
            &project_dir,
            "session",
            &project_path,
            "hi",
            "2020-01-01T00:00:00.000Z",
        );
        append_jsonl_line(
            &project_dir,
            "session",
            r#"{"type":"assistant","timestamp":"2026-07-21T11:00:00.000Z","message":{"role":"assistant","content":"still here"}}"#,
        );
        append_jsonl_line(
            &project_dir,
            "session",
            r#"{"type":"last-prompt","lastPrompt":"more","leafUuid":"x","sessionId":"session"}"#,
        );

        let sessions = scan_projects_dir(root.path(), &project_path);
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].created_at.as_deref(),
            Some("2020-01-01T00:00:00.000Z")
        );
        assert_eq!(
            sessions[0].updated_at.as_deref(),
            Some("2026-07-21T11:00:00.000Z")
        );
    }

    #[test]
    fn updated_at_falls_back_to_mtime_when_the_newest_event_timestamp_is_malformed_or_missing() {
        let root = TempDir::new("projects-root-fallback");
        let project = TempDir::new("project-fallback");
        let project_path = project.path().to_str().unwrap().to_string();
        let project_dir = root.path().join(encode(&project_path));

        // The newest timestamp-bearing line is malformed. An earlier line
        // (the creation line) has a perfectly valid — but much older —
        // timestamp; a correct implementation must NOT fall through to it.
        write_session_jsonl(
            &project_dir,
            "malformed-tail",
            &project_path,
            "hi",
            "2020-01-01T00:00:00.000Z",
        );
        append_jsonl_line(
            &project_dir,
            "malformed-tail",
            r#"{"type":"assistant","timestamp":"not-a-real-timestamp","message":{"role":"assistant","content":"oops"}}"#,
        );

        // No line in the file carries a timestamp field at all.
        write_session_jsonl_without_timestamp(
            &project_dir,
            "missing-timestamps",
            &project_path,
            "hi",
        );

        let sessions = scan_projects_dir(root.path(), &project_path);

        let malformed = sessions
            .iter()
            .find(|s| s.id == "malformed-tail")
            .expect("malformed-tail session must still be listed");
        assert_close_to_now(malformed.updated_at.as_deref().unwrap(), 30);
        assert_ne!(
            malformed.updated_at.as_deref(),
            Some("2020-01-01T00:00:00.000Z"),
            "must not fall through to the older valid creation timestamp"
        );

        let missing = sessions
            .iter()
            .find(|s| s.id == "missing-timestamps")
            .expect("missing-timestamps session must still be listed");
        assert_close_to_now(missing.updated_at.as_deref().unwrap(), 30);
        assert_eq!(missing.created_at, None);
    }

    #[test]
    fn equal_updated_at_breaks_ties_by_session_id_ascending() {
        let root = TempDir::new("projects-root-tie");
        let project = TempDir::new("project-tie");
        let project_path = project.path().to_str().unwrap().to_string();
        let project_dir = root.path().join(encode(&project_path));

        // Both sessions share the exact same (and only) timestamp, so
        // updated_at and created_at are identical between them — only the
        // session id tie-break can produce a stable, deterministic order.
        write_session_jsonl(
            &project_dir,
            "session-b",
            &project_path,
            "hi",
            "2026-01-01T00:00:00.000Z",
        );
        write_session_jsonl(
            &project_dir,
            "session-a",
            &project_path,
            "hi",
            "2026-01-01T00:00:00.000Z",
        );

        let sessions = scan_projects_dir(root.path(), &project_path);

        assert_eq!(
            sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["session-a", "session-b"],
            "identical updated_at/created_at must still produce a deterministic order via session id"
        );
    }

    #[test]
    fn list_sessions_scopes_to_resolved_config_root_only() {
        let bin = TempDir::new("direnv-bin");
        write_fake_direnv(bin.path());

        let default_root = TempDir::new("default-root"); // stands in for ~/.claude (default profile)
        let custom_root = TempDir::new("custom-root"); // stands in for $CLAUDE_CONFIG_DIR (custom profile)
        let project = TempDir::new("project-custom-profile");
        let project_path = project.path().to_str().unwrap().to_string();
        let encoded = encode(&project_path);

        // The default profile already has a session recorded for this exact
        // cwd — e.g. from before the project's .envrc existed.
        write_session_jsonl(
            &default_root.path().join("projects").join(&encoded),
            "default-profile-session",
            &project_path,
            "hi from default profile",
            "2026-01-01T00:00:00.000Z",
        );

        // The custom profile has its own session for the same cwd.
        write_session_jsonl(
            &custom_root.path().join("projects").join(&encoded),
            "custom-profile-session",
            &project_path,
            "hi from custom profile",
            "2026-01-01T00:00:00.000Z",
        );

        // Fake direnv points CLAUDE_CONFIG_DIR at the custom root, exactly
        // like `resolve_project_env` would resolve it for `pty_open`.
        let mut env = HashMap::new();
        env.insert("PATH".into(), bin.path().display().to_string());
        env.insert("HOME".into(), "/tmp".into());
        env.insert(
            "FAKE_DIRENV_STDOUT".into(),
            format!(
                r#"{{"CLAUDE_CONFIG_DIR":"{}"}}"#,
                custom_root.path().display()
            ),
        );

        let resolved = crate::project_env::resolve_project_env(&project_path, Some(env), vec![])
            .expect("direnv export should succeed");
        let config_dir = resolved
            .into_iter()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
            .map(|(_, v)| PathBuf::from(v));

        let projects_dir = projects_dir_for(config_dir).expect("resolves a projects dir");
        assert_eq!(projects_dir, custom_root.path().join("projects"));

        let sessions = scan_projects_dir(&projects_dir, &project_path);

        assert_eq!(
            sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["custom-profile-session"],
            "must return only the custom-profile session, never merge in the default root"
        );

        // The default root is never touched by a resolution that found a
        // custom CLAUDE_CONFIG_DIR — confirm it independent of the above.
        assert!(default_root.path().join("projects").join(&encoded).exists());
    }

    #[test]
    fn scan_returns_empty_when_custom_projects_dir_does_not_exist() {
        let project = TempDir::new("project-missing-root");
        let project_path = project.path().to_str().unwrap().to_string();

        // CLAUDE_CONFIG_DIR resolved to a path whose `projects` subdir was
        // never created — must yield an empty list, not an error and not a
        // fallback to ~/.claude/projects.
        let missing_root = TempDir::new("config-root-without-projects-subdir");
        let projects_dir = projects_dir_for(Some(missing_root.path().to_path_buf())).unwrap();
        assert!(!projects_dir.exists());

        let sessions = scan_projects_dir(&projects_dir, &project_path);
        assert!(sessions.is_empty());
    }

    #[test]
    fn projects_dir_for_none_defaults_to_dot_claude() {
        let home = dirs::home_dir().expect("home dir must resolve in test env");
        assert_eq!(projects_dir_for(None), Some(home.join(".claude/projects")));
    }
}
