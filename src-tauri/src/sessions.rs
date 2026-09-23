use chrono::{DateTime, SecondsFormat, Utc};

use crate::agent::AgentId;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const SCAN_LINES_FOR_CWD: usize = 50;
const PREVIEW_MAX_CHARS: usize = 140;

// Boot-only. `session_watcher::seed_seen` reads this much of each JSONL
// once, so a session that already finished doesn't chime on launch. The
// list refresh and the watcher tick do not: `updated_at` and completion
// live on the incremental cursor in `scan_session_file`.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// Candidate lines kept per recency field while a chunk is scanned. Only
/// the newest real timestamp and the newest assistant line matter, so a
/// large transcript is not parsed line by line — the last few substring
/// hits are kept and walked newest-first. Eight covers a short run of
/// false positives (the substring inside message content) without holding
/// the file. If all eight are false positives, that file falls back to the
/// tail read below so the answer stays the one the tail used to give.
const RECENCY_CANDIDATES: usize = 8;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    /// Which agent wrote this session. Set by the provider that produced it,
    /// never inferred by a consumer: with more than one agent the sessions
    /// list is a merge, and a row that cannot name its agent is a row we
    /// cannot resume correctly.
    pub agent: String,
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
pub(crate) fn ts_key(v: &Option<String>) -> Option<DateTime<Utc>> {
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

pub(crate) fn canonical(path: &str) -> String {
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

pub(crate) fn truncate(s: &str) -> String {
    let trimmed = s.trim().replace('\n', " ");
    if trimmed.chars().count() <= PREVIEW_MAX_CHARS {
        trimmed
    } else {
        let mut out: String = trimmed.chars().take(PREVIEW_MAX_CHARS).collect();
        out.push('…');
        out
    }
}

#[derive(Clone, Default)]
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
    /// Newest top-level `timestamp` among committed lines. `None` means no
    /// such line yet. `Some(Malformed)` means the newest one did not parse:
    /// `updated_at` falls back to mtime and must not surface an older valid
    /// timestamp further up the file.
    latest_timestamp: Option<TimestampOutcome>,
    /// Newest top-level `type: "assistant"` line, whether or not its
    /// `stop_reason` is terminal. `assistant_complete_from_scan` applies
    /// that rule.
    last_assistant: Option<AssistantSnapshot>,
}

/// Outcome of the newest line that carries a top-level `timestamp` string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TimestampOutcome {
    Valid(DateTime<Utc>),
    Malformed,
}

/// The last assistant line, before the terminal-stop rule. A non-terminal
/// `stop_reason` (or a missing uuid) still has to be remembered: the next
/// line is often bookkeeping, and forgetting this one would resurrect an
/// older `end_turn`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct AssistantSnapshot {
    uuid: Option<String>,
    stop_reason: String,
    preview: Option<String>,
}

const TERMINAL_STOP_REASONS: &[&str] = &["end_turn", "max_tokens", "stop_sequence", "refusal"];

fn assistant_complete(snap: &AssistantSnapshot) -> Option<AssistantComplete> {
    if !TERMINAL_STOP_REASONS.contains(&snap.stop_reason.as_str()) {
        return None;
    }
    Some(AssistantComplete {
        uuid: snap.uuid.clone()?,
        stop_reason: snap.stop_reason.clone(),
        preview: snap.preview.clone(),
    })
}

enum TimestampHit {
    Skip,
    Found(TimestampOutcome),
}

/// Top-level `timestamp` on one JSONL line. Unparseable lines and lines
/// with no string timestamp are skipped; a string that is not RFC 3339
/// stops the search (`Malformed`), same as the tail walker.
fn timestamp_hit(line: &str) -> TimestampHit {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return TimestampHit::Skip;
    };
    let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) else {
        return TimestampHit::Skip;
    };
    match parse_rfc3339(ts) {
        Some(dt) => TimestampHit::Found(TimestampOutcome::Valid(dt)),
        None => TimestampHit::Found(TimestampOutcome::Malformed),
    }
}

fn timestamp_outcome_from_lines(lines: &[String]) -> Option<TimestampOutcome> {
    for line in lines.iter().rev() {
        if let TimestampHit::Found(outcome) = timestamp_hit(line) {
            return Some(outcome);
        }
    }
    None
}

fn assistant_snapshot_of_line(line: &str) -> Option<AssistantSnapshot> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return None;
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    let stop_reason = v
        .pointer("/message/stop_reason")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let uuid = v.get("uuid").and_then(|u| u.as_str()).map(str::to_string);
    let preview = v
        .pointer("/message/content")
        .and_then(extract_text_from_content)
        .map(|s| truncate(&s));
    Some(AssistantSnapshot {
        uuid,
        stop_reason,
        preview,
    })
}

fn assistant_snapshot_from_lines(lines: &[String]) -> Option<AssistantSnapshot> {
    for line in lines.iter().rev() {
        if let Some(snap) = assistant_snapshot_of_line(line) {
            return Some(snap);
        }
    }
    None
}

/// Applies one not-yet-committed line (the partial tail) to a scan copy.
/// Substring-gated so a bookkeeping fragment doesn't pay for `serde_json`.
fn consider_recency_line(scan: &mut SessionScan, line: &str) {
    if line.contains("\"timestamp\":") {
        if let TimestampHit::Found(outcome) = timestamp_hit(line) {
            scan.latest_timestamp = Some(outcome);
        }
    }
    if line.contains("\"type\":\"assistant\"") {
        if let Some(snap) = assistant_snapshot_of_line(line) {
            scan.last_assistant = Some(snap);
        }
    }
}

/// Byte range of one candidate line. Spans, not copies: a first scan of a
/// multi-hundred-MB transcript must not allocate a `String` per line just
/// to throw all but the last few away.
struct LineSpan {
    start: u64,
    len: u32,
}

/// Last few substring hits in one read. `dropped` means an older hit fell
/// out of the window; if none of the survivors is a real top-level match,
/// the caller must not trust the window.
struct CandidateWindow {
    spans: VecDeque<LineSpan>,
    dropped: bool,
}

enum Resolved<T> {
    Found(T),
    Unchanged,
    Fallback,
}

fn read_span(file: &mut fs::File, span: &LineSpan) -> Option<String> {
    file.seek(SeekFrom::Start(span.start)).ok()?;
    let mut buf = vec![0u8; span.len as usize];
    file.read_exact(&mut buf).ok()?;
    let line = String::from_utf8(buf).ok()?;
    Some(line.trim_end_matches('\r').to_string())
}

impl CandidateWindow {
    fn new() -> Self {
        Self {
            spans: VecDeque::with_capacity(RECENCY_CANDIDATES),
            dropped: false,
        }
    }

    fn push(&mut self, start: u64, len: u64) {
        let Ok(len) = u32::try_from(len) else {
            // A single line longer than 4 GiB cannot be re-read as a span.
            // Drop the window so the caller falls back to the tail.
            self.spans.clear();
            self.dropped = true;
            return;
        };
        if self.spans.len() == RECENCY_CANDIDATES {
            self.spans.pop_front();
            self.dropped = true;
        }
        self.spans.push_back(LineSpan { start, len });
    }

    fn resolve_timestamp(&self, file: &Path) -> Resolved<TimestampOutcome> {
        if self.spans.is_empty() {
            return if self.dropped {
                Resolved::Fallback
            } else {
                Resolved::Unchanged
            };
        }
        let Ok(mut f) = fs::File::open(file) else {
            return if self.dropped {
                Resolved::Fallback
            } else {
                Resolved::Unchanged
            };
        };
        for span in self.spans.iter().rev() {
            let Some(line) = read_span(&mut f, span) else {
                continue;
            };
            if let TimestampHit::Found(outcome) = timestamp_hit(&line) {
                return Resolved::Found(outcome);
            }
        }
        if self.dropped {
            Resolved::Fallback
        } else {
            Resolved::Unchanged
        }
    }

    fn resolve_assistant(&self, file: &Path) -> Resolved<AssistantSnapshot> {
        if self.spans.is_empty() {
            return if self.dropped {
                Resolved::Fallback
            } else {
                Resolved::Unchanged
            };
        }
        let Ok(mut f) = fs::File::open(file) else {
            return if self.dropped {
                Resolved::Fallback
            } else {
                Resolved::Unchanged
            };
        };
        for span in self.spans.iter().rev() {
            let Some(line) = read_span(&mut f, span) else {
                continue;
            };
            if let Some(snap) = assistant_snapshot_of_line(&line) {
                return Resolved::Found(snap);
            }
        }
        if self.dropped {
            Resolved::Fallback
        } else {
            Resolved::Unchanged
        }
    }
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

/// Folds one JSONL line into a scan: first user message (sticky),
/// `custom-title` and `summary` (last write wins). Order-independent in the
/// only way that matters — every field either sticks at its first value or
/// takes its latest — which is what lets `scan_session_file` resume from
/// where it stopped instead of starting over.
fn fold_line(scan: &mut SessionScan, line: &str) {
    let need_conv = scan.first_preview.is_none() || !scan.has_conversation;
    if !line_may_matter(line, need_conv) {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
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

/// How far into a file a scan has already got, and what it found there.
/// `ino` / `dev` identify the file itself, so a JSONL replaced by another at
/// the same path is rescanned rather than resumed from an offset that
/// belongs to something else.
struct ScanCursor {
    dev: u64,
    ino: u64,
    /// Bytes consumed — always at a line boundary.
    offset: u64,
    scan: SessionScan,
}

/// Per-file scan progress, including `updated_at` and the last assistant
/// line. Without it every watcher tick re-read the whole transcript from
/// byte zero, and so did every Sessions-list refresh — an active session
/// with a 77 MB JSONL cost a full read every 200 ms while it was being
/// written, and each tick of *any* session refreshed the list and re-read
/// every transcript of the open project on top of that (measured, PRP 024
/// QA). Session files are append-only logs, so the work that is actually
/// new is only ever the bytes appended since the last look. Recency used
/// to be a separate 4 MiB tail read on that same tick (#113); it is folded
/// into this cursor so a refresh that changes nothing reads zero bytes.
///
/// Bounded by a crude clear rather than LRU: an entry is a few short strings,
/// the cap is far above the number of transcripts anyone has open, and
/// losing the cache only costs one full scan per file.
static SCAN_CACHE: LazyLock<Mutex<HashMap<PathBuf, ScanCursor>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const SCAN_CACHE_CAP: usize = 4096;

#[cfg(unix)]
fn file_identity(meta: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(not(unix))]
fn file_identity(_meta: &fs::Metadata) -> (u64, u64) {
    (0, 0)
}

/// Scans a JSONL for its first user message, `custom-title`, `summary`,
/// the newest top-level timestamp (`updated_at`) and the newest assistant
/// line (completion), reading only what was appended since this file was
/// last scanned.
///
/// Falls back to a scan from byte zero when there is no usable cursor: first
/// sight, a different file at the same path, or a file shorter than where we
/// stopped (truncated or rewritten). A trailing line without its newline yet
/// is folded into the result but not committed, so it is re-read once it is
/// complete — the answer is always what a full scan would say. Timestamp and
/// assistant lines are not parsed one by one: a substring gate keeps the
/// last few candidates and only those are decoded.
pub(crate) fn scan_session_file(file: &Path) -> SessionScan {
    let Ok(meta) = fs::metadata(file) else {
        return SessionScan::default();
    };
    let (dev, ino) = file_identity(&meta);
    let len = meta.len();

    let (start, mut committed) = {
        let cache = SCAN_CACHE.lock().ok();
        match cache.as_ref().and_then(|c| c.get(file)) {
            Some(cur) if cur.dev == dev && cur.ino == ino && cur.offset <= len => {
                (cur.offset, cur.scan.clone())
            }
            _ => (0, SessionScan::default()),
        }
    };
    if start == len {
        return committed;
    }

    let Ok(mut f) = fs::File::open(file) else {
        return committed;
    };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return committed;
    }
    let mut reader = BufReader::new(f);
    let mut offset = start;
    let mut pending: Option<Vec<u8>> = None;
    let mut buf = Vec::new();
    let mut timestamps = CandidateWindow::new();
    let mut assistants = CandidateWindow::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if buf.last() != Some(&b'\n') {
            // Still being written. Look at it, don't commit to it.
            pending = Some(std::mem::take(&mut buf));
            break;
        }
        let line_start = offset;
        let line_len = (n as u64).saturating_sub(1);
        offset += n as u64;
        if let Ok(line) = std::str::from_utf8(&buf[..line_len as usize]) {
            let line = line.trim_end_matches('\r');
            fold_line(&mut committed, line);
            if line.contains("\"timestamp\":") {
                timestamps.push(line_start, line_len);
            }
            if line.contains("\"type\":\"assistant\"") {
                assistants.push(line_start, line_len);
            }
        }
    }

    let ts_fallback = match timestamps.resolve_timestamp(file) {
        Resolved::Found(outcome) => {
            committed.latest_timestamp = Some(outcome);
            false
        }
        Resolved::Unchanged => false,
        Resolved::Fallback => true,
    };
    let as_fallback = match assistants.resolve_assistant(file) {
        Resolved::Found(snap) => {
            committed.last_assistant = Some(snap);
            false
        }
        Resolved::Unchanged => false,
        Resolved::Fallback => true,
    };
    if ts_fallback || as_fallback {
        // The real line was evicted from the window. Re-derive that field
        // from the tail so this file still matches the pre-incremental
        // answer. The partial line at the end is not part of `committed`.
        if let Some(lines) = read_tail_lines(file) {
            let end = if pending.is_some() {
                lines.len().saturating_sub(1)
            } else {
                lines.len()
            };
            let committed_lines = &lines[..end];
            if ts_fallback {
                committed.latest_timestamp = timestamp_outcome_from_lines(committed_lines);
            }
            if as_fallback {
                committed.last_assistant = assistant_snapshot_from_lines(committed_lines);
            }
        }
    }

    let mut result = committed.clone();
    if let Some(tail) = pending {
        if let Ok(line) = std::str::from_utf8(&tail) {
            fold_line(&mut result, line);
            consider_recency_line(&mut result, line.trim_end_matches('\r'));
        }
    }

    if let Ok(mut cache) = SCAN_CACHE.lock() {
        if cache.len() >= SCAN_CACHE_CAP && !cache.contains_key(file) {
            cache.clear();
        }
        cache.insert(
            file.to_path_buf(),
            ScanCursor {
                dev,
                ino,
                offset,
                scan: committed,
            },
        );
    }
    result
}

/// Result of scanning the tail of a JSONL for the most recent assistant
/// message that ended the turn. `None` means either no such message exists
/// yet or the file is unreadable. Used by `session_watcher` to fire
/// `session:complete` notifications.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AssistantComplete {
    pub uuid: String,
    pub stop_reason: String,
    pub preview: Option<String>,
}

/// Reads the last `TAIL_BYTES` of a JSONL and returns its lines in file
/// order. Used by `session_watcher::seed_seen` at boot (one pass over
/// transcripts that already exist) and as the rare fallback when a scan
/// window is nothing but false-positive substring hits. The list and the
/// watcher tick do not call it.
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
    assistant_snapshot_from_lines(lines)
        .as_ref()
        .and_then(assistant_complete)
}

/// Completion fact carried by an incremental scan. `None` when the newest
/// assistant line is missing, still in `tool_use`, or has no uuid — the
/// same three outcomes as [`last_assistant_complete_from_tail`].
pub(crate) fn assistant_complete_from_scan(scan: &SessionScan) -> Option<AssistantComplete> {
    scan.last_assistant.as_ref().and_then(assistant_complete)
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
#[cfg(test)]
fn latest_event_timestamp_from_tail(lines: &[String]) -> Option<DateTime<Utc>> {
    match timestamp_outcome_from_lines(lines) {
        Some(TimestampOutcome::Valid(dt)) => Some(dt),
        Some(TimestampOutcome::Malformed) | None => None,
    }
}

fn mtime_utc(file: &Path) -> Option<DateTime<Utc>> {
    let modified = fs::metadata(file).ok()?.modified().ok()?;
    Some(modified.into())
}

/// Canonical `updated_at` for a session: the newest valid top-level
/// timestamp remembered by `scan`, falling back to the file's mtime when
/// that timestamp is missing or malformed. Normalized the same way as
/// [`canonicalize_rfc3339`] so recency comparisons never depend on
/// differing offsets or fractional-second precision.
pub(crate) fn session_updated_at(file: &Path, scan: &SessionScan) -> Option<String> {
    let from_log = match scan.latest_timestamp {
        Some(TimestampOutcome::Valid(dt)) => Some(dt),
        Some(TimestampOutcome::Malformed) | None => None,
    };
    from_log
        .or_else(|| mtime_utc(file))
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// What `updated_at` was before it moved onto the incremental cursor: the
/// tail walk, then mtime. Equivalence tests compare [`session_updated_at`]
/// against this.
#[cfg(test)]
fn tail_session_updated_at(file: &Path) -> Option<String> {
    let lines = read_tail_lines(file).unwrap_or_default();
    latest_event_timestamp_from_tail(&lines)
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
    agent_id: String,
) -> Result<Vec<SessionMeta>, String> {
    let agent_id = crate::agent::AgentId::parse(&agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent::list_sessions(agent_id, &project_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Claude's session provider (`agent::list_sessions`). Kept here rather than
/// in `agent.rs` because it is all Claude-specific JSONL knowledge.
pub(crate) fn list_claude_sessions(project_path: &str) -> Result<Vec<SessionMeta>, String> {
    // Fails closed on a direnv evaluation error (see project_env.rs) — we
    // never fall back to the default ~/.claude/projects after a failure,
    // since that could show sessions from the wrong Claude account.
    let config_dir = crate::project_env::resolve_claude_config_dir(project_path)?;
    let projects_dir =
        projects_dir_for(config_dir).ok_or("cannot resolve Claude sessions directory")?;
    if !projects_dir.exists() {
        return Ok(vec![]);
    }
    Ok(scan_projects_dir(&projects_dir, project_path))
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
                // `updated_at` comes off the same cursor as the preview.
                // A warm refresh stats every file and reads only a session
                // that actually grew. Taken before the fields below move
                // `scan` apart.
                let updated_at = session_updated_at(&p, &scan);
                out.push(SessionMeta {
                    id,
                    agent: AgentId::Claude.as_str().to_string(),
                    created_at: scan.first_timestamp.map(|ts| canonicalize_rfc3339(&ts)),
                    updated_at,
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

    fn user_line(text: &str) -> String {
        format!(
            r#"{{"type":"user","cwd":"/p","timestamp":"2026-09-01T00:00:00Z","message":{{"role":"user","content":"{text}"}}}}"#
        ) + "\n"
    }

    fn title_line(title: &str) -> String {
        format!(r#"{{"type":"custom-title","customTitle":"{title}"}}"#) + "\n"
    }

    fn append(path: &Path, text: &str) {
        use std::io::Write as _;
        let mut f = fs::OpenOptions::new().append(true).create(true).open(path).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    // The CPU regression this exists for: a live transcript is scanned on
    // every watcher tick. Resuming must give exactly what a full scan gives.
    #[test]
    fn a_resumed_scan_sees_what_was_appended() {
        let dir = TempDir::new("incr-append");
        let file = dir.path().join("s.jsonl");
        append(&file, &user_line("first question"));
        let before = scan_session_file(&file);
        assert_eq!(before.first_preview.as_deref(), Some("first question"));
        assert!(before.custom_title.is_none());

        append(&file, &user_line("second question"));
        append(&file, &title_line("Renamed"));
        let after = scan_session_file(&file);
        assert_eq!(after.first_preview.as_deref(), Some("first question"));
        assert_eq!(after.custom_title.as_deref(), Some("Renamed"));

        // Same answer as a file scanned from scratch.
        let fresh = dir.path().join("fresh.jsonl");
        fs::copy(&file, &fresh).unwrap();
        assert_eq!(scan_session_file(&fresh).custom_title.as_deref(), Some("Renamed"));
    }

    #[test]
    fn a_line_still_being_written_is_read_once_it_is_complete() {
        let dir = TempDir::new("incr-partial");
        let file = dir.path().join("s.jsonl");
        append(&file, &user_line("hello"));
        let whole = title_line("Late title");
        let (head, tail) = whole.split_at(20);
        append(&file, head);
        assert!(scan_session_file(&file).custom_title.is_none());

        append(&file, tail);
        assert_eq!(scan_session_file(&file).custom_title.as_deref(), Some("Late title"));
    }

    // A file replaced at the same path must not be resumed from an offset
    // that belongs to its predecessor.
    #[test]
    fn a_rewritten_file_is_scanned_again_from_the_start() {
        let dir = TempDir::new("incr-rewrite");
        let file = dir.path().join("s.jsonl");
        append(&file, &user_line("original question, rather long to be sure"));
        append(&file, &title_line("Old"));
        scan_session_file(&file);

        let replacement = dir.path().join("tmp.jsonl");
        append(&replacement, &user_line("new"));
        fs::rename(&replacement, &file).unwrap();
        let rescanned = scan_session_file(&file);
        assert_eq!(rescanned.first_preview.as_deref(), Some("new"));
        assert!(rescanned.custom_title.is_none());
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Recency {
        updated_at: Option<String>,
        complete: Option<AssistantComplete>,
    }

    fn incremental_recency(file: &Path) -> Recency {
        let scan = scan_session_file(file);
        Recency {
            updated_at: session_updated_at(file, &scan),
            complete: assistant_complete_from_scan(&scan),
        }
    }

    fn tail_recency(file: &Path) -> Recency {
        let lines = read_tail_lines(file).unwrap_or_default();
        Recency {
            updated_at: tail_session_updated_at(file),
            complete: last_assistant_complete_from_tail(&lines),
        }
    }

    /// Cuts `body` so at least one piece ends in the middle of a line.
    fn pieces_with_midline_cut(body: &str) -> Vec<&str> {
        let bytes = body.as_bytes();
        if bytes.len() < 8 {
            return vec![body];
        }
        let mut cut = bytes.len() / 3;
        if bytes[cut - 1] == b'\n' || bytes[cut] == b'\n' {
            cut += 1;
        }
        let (head, rest) = body.split_at(cut);
        let mut cut2 = rest.len() / 2;
        if cut2 > 0 && (rest.as_bytes()[cut2 - 1] == b'\n' || rest.as_bytes()[cut2] == b'\n') {
            cut2 += 1;
        }
        cut2 = cut2.min(rest.len());
        let (mid, tail) = rest.split_at(cut2);
        [head, mid, tail].into_iter().filter(|s| !s.is_empty()).collect()
    }

    fn assert_chunked_matches_tail(label: &str, body: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new(label);
        let file = dir.path().join("s.jsonl");
        for (i, piece) in pieces_with_midline_cut(body).into_iter().enumerate() {
            append(&file, piece);
            assert_eq!(
                incremental_recency(&file),
                tail_recency(&file),
                "{label} diverged after piece {i}"
            );
        }
        (dir, file)
    }

    fn assistant_line(uuid: &str, ts: &str, stop: &str, text: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"{text}"}}],"stop_reason":"{stop}"}}}}"#
        ) + "\n"
    }

    #[test]
    fn incremental_recency_matches_tail_for_malformed_newest_timestamp() {
        let body = user_line("hi")
            + &assistant_line("bad", "not-a-real-timestamp", "end_turn", "oops");
        let (_dir, file) = assert_chunked_matches_tail("eq-malformed", &body);
        let got = incremental_recency(&file);
        assert_close_to_now(got.updated_at.as_deref().unwrap(), 30);
        assert_ne!(got.updated_at.as_deref(), Some("2026-09-01T00:00:00.000Z"));
    }

    #[test]
    fn incremental_recency_matches_tail_when_the_file_ends_in_last_prompt() {
        let body = user_line("hi")
            + &assistant_line("a1", "2026-04-01T00:00:00.000Z", "end_turn", "done")
            + "{\"type\":\"last-prompt\",\"lastPrompt\":\"more\",\"leafUuid\":\"x\",\"sessionId\":\"s\"}\n";
        let (_dir, file) = assert_chunked_matches_tail("eq-last-prompt", &body);
        let got = incremental_recency(&file);
        assert_eq!(got.updated_at.as_deref(), Some("2026-04-01T00:00:00.000Z"));
        assert_eq!(got.complete.as_ref().map(|c| c.uuid.as_str()), Some("a1"));
        assert_eq!(got.complete.as_ref().map(|c| c.stop_reason.as_str()), Some("end_turn"));
    }

    #[test]
    fn incremental_recency_matches_tail_when_tool_use_follows_end_turn() {
        let body = assistant_line("a1", "2026-04-01T00:00:00.000Z", "end_turn", "done")
            + &assistant_line("a2", "2026-04-02T00:00:00.000Z", "tool_use", "calling");
        let (_dir, file) = assert_chunked_matches_tail("eq-tool-use", &body);
        let got = incremental_recency(&file);
        assert!(got.complete.is_none(), "tool_use is not a completed turn");
        assert_eq!(got.updated_at.as_deref(), Some("2026-04-02T00:00:00.000Z"));
    }

    #[test]
    fn incremental_recency_ignores_assistant_nested_in_user_content() {
        let body = assistant_line("a1", "2026-04-01T00:00:00.000Z", "end_turn", "done")
            + "{\"type\":\"user\",\"uuid\":\"u2\",\"timestamp\":\"2026-04-02T00:00:00.000Z\",\"cwd\":\"/p\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"see\"},{\"type\":\"assistant\",\"text\":\"not really\"}]}}\n";
        let (_dir, file) = assert_chunked_matches_tail("eq-nested", &body);
        let got = incremental_recency(&file);
        assert_eq!(got.complete.as_ref().map(|c| c.uuid.as_str()), Some("a1"));
        assert_eq!(got.updated_at.as_deref(), Some("2026-04-02T00:00:00.000Z"));
    }

    #[test]
    fn incremental_recency_resets_when_the_file_is_replaced() {
        let original = assistant_line("old", "2026-01-01T00:00:00.000Z", "end_turn", "old");
        let (_dir, file) = assert_chunked_matches_tail("eq-replace", &original);
        let replacement = file.with_file_name("tmp.jsonl");
        append(
            &replacement,
            &assistant_line("new", "2026-08-01T00:00:00.000Z", "end_turn", "new"),
        );
        fs::rename(&replacement, &file).unwrap();
        assert_eq!(incremental_recency(&file), tail_recency(&file));
        assert_eq!(
            incremental_recency(&file).complete.as_ref().map(|c| c.uuid.as_str()),
            Some("new")
        );
    }

    #[test]
    fn incremental_recency_resets_when_the_file_is_truncated() {
        let original = assistant_line("old", "2026-01-01T00:00:00.000Z", "end_turn", "old")
            + &assistant_line("older", "2026-06-01T00:00:00.000Z", "end_turn", "later");
        let (_dir, file) = assert_chunked_matches_tail("eq-truncate", &original);
        fs::write(
            &file,
            assistant_line("short", "2024-02-02T00:00:00.000Z", "max_tokens", "cut"),
        )
        .unwrap();
        let got = incremental_recency(&file);
        assert_eq!(got, tail_recency(&file));
        assert_eq!(got.complete.as_ref().map(|c| c.uuid.as_str()), Some("short"));
        assert_eq!(got.complete.as_ref().map(|c| c.stop_reason.as_str()), Some("max_tokens"));
        assert_eq!(got.updated_at.as_deref(), Some("2024-02-02T00:00:00.000Z"));
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
