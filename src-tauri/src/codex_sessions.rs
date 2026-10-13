//! Codex's session provider (`agent::list_sessions`) — unlike Claude
//! (project-path-keyed) and Cursor (cwd-hash-keyed), Codex's rollout files
//! are keyed by **date**, with `cwd` and the session's own id both nested
//! inside the first JSONL line's `payload`.
//!
//! Layout, confirmed directly against codex-cli 0.146.0 on this machine:
//! `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
//! `CODEX_HOME` defaults to `~/.codex`; this provider only ever reads the
//! default root (see `agent::supports_profiles(Codex) == false` — Codex
//! profiles are a deferred follow-up, not implemented here).
//!
//! **The file's own `payload.id` is not what `codex resume`/`archive`/
//! `fork` mean by "session id".** Confirmed by sampling real rollout files
//! on this machine: a conversation that has been resumed more than once has
//! *multiple* rollout files — one per resume — each with its own distinct
//! `payload.id` (matching that file's own filename), but all sharing the
//! same `payload.session_id`, which is the value every one of `codex`'s own
//! `--help` texts calls "the session id". Using `payload.id` as
//! `SessionMeta.id` would make each resume of the same conversation show up
//! as its own, separately-resumable row — wrong, and confusing. Every
//! `SessionMeta` this module produces uses `payload.session_id`; rollout
//! files that share one are collapsed into a single row, keeping whichever
//! file was modified most recently.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;

use crate::agent::AgentId;
use crate::sessions::{canonical, canonicalize_rfc3339, truncate, ts_key, SessionMeta};

const FILENAME_PREFIX: &str = "rollout-";
const FILENAME_SUFFIX: &str = ".jsonl";

/// How far into a rollout file to look for the first real user message
/// before giving up — bounded so a provider scan over a long-running
/// session stays cheap. 200 lines comfortably covers the handful of
/// `session_meta`/`event_msg`/`turn_context` bookkeeping lines plus the
/// synthetic `environment_context` message observed before the real first
/// prompt on every rollout sampled on this machine.
const SCAN_LINES_FOR_PREVIEW: usize = 200;

pub(crate) fn sessions_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex/sessions"))
}

pub(crate) fn is_rollout_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(FILENAME_PREFIX) && n.ends_with(FILENAME_SUFFIX))
}

/// Every `rollout-*.jsonl` under `root`, at any depth. Codex partitions by
/// date (`YYYY/MM/DD/`), but this walks generically rather than assuming
/// exactly three levels, so a future change to the partition depth would
/// not silently stop finding files.
pub(crate) fn list_rollout_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(root, &mut out);
    out
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
        } else if is_rollout_file(&path) {
            out.push(path);
        }
    }
}

#[derive(Debug, Deserialize)]
struct RolloutFirstLine {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<String>,
    payload: Option<SessionMetaPayload>,
}

#[derive(Debug, Deserialize)]
struct SessionMetaPayload {
    session_id: Option<String>,
    // Older Codex rollouts (observed through 0.140.0-alpha.2) predate
    // `session_id`. For those files `id` is the only resumable identifier;
    // modern resumed rollouts still prefer the stable `session_id` above.
    id: Option<String>,
    cwd: Option<String>,
}

fn read_first_line(path: &Path) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(f);
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => None,
        Ok(_) => Some(line),
        Err(_) => None,
    }
}

/// Reads just the first line of a rollout file — never the whole file — and
/// pulls out what both the provider and the watcher need: the stable
/// session id (see module docs — NOT `payload.id`), the cwd, and the line's
/// own timestamp (a cheap `created_at`, needing no further parsing). `None`
/// for anything that is not yet a readable `session_meta` first line — a
/// file still being written included — so the caller can bail and retry on
/// the next tick, the same contract `sessions.rs::read_cwd` has for Claude.
fn read_session_meta_line(path: &Path) -> Option<(String, String, Option<String>)> {
    let line = read_first_line(path)?;
    let parsed: RolloutFirstLine = serde_json::from_str(line.trim_end()).ok()?;
    if parsed.kind != "session_meta" {
        return None;
    }
    let payload = parsed.payload?;
    let session_id = payload.session_id.or(payload.id)?;
    Some((session_id, payload.cwd?, parsed.timestamp))
}

fn mtime_to_rfc3339(path: &Path) -> Option<String> {
    let mtime = fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let dt: DateTime<Utc> = mtime.into();
    Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[derive(Debug, Deserialize)]
struct ResponseItemLine {
    #[serde(rename = "type")]
    kind: String,
    payload: Option<ResponseItemPayload>,
}

#[derive(Debug, Deserialize)]
struct ResponseItemPayload {
    #[serde(rename = "type")]
    payload_type: Option<String>,
    role: Option<String>,
    content: Option<Vec<ContentBlock>>,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: Option<String>,
    text: Option<String>,
}

/// Codex's synthetic first turn is environment bookkeeping the user never
/// typed — `<environment_context><cwd>...</cwd>...</environment_context>` —
/// confirmed on every rollout sampled on this machine. A preview built from
/// "the first user message" verbatim would show that XML blob instead of
/// anything the user actually asked.
fn is_synthetic_environment_context(text: &str) -> bool {
    text.trim_start().starts_with("<environment_context>")
}

/// The first thing the user actually typed, bounded to
/// `SCAN_LINES_FOR_PREVIEW` lines so a long-running session's provider scan
/// cannot turn into reading the whole file.
fn first_real_user_message(path: &Path) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let reader = BufReader::new(f);
    for line in reader.lines().map_while(Result::ok).take(SCAN_LINES_FOR_PREVIEW) {
        let Ok(parsed) = serde_json::from_str::<ResponseItemLine>(&line) else {
            continue;
        };
        if parsed.kind != "response_item" {
            continue;
        }
        let Some(payload) = parsed.payload else { continue };
        if payload.payload_type.as_deref() != Some("message") || payload.role.as_deref() != Some("user")
        {
            continue;
        }
        let Some(content) = payload.content else { continue };
        for block in content {
            if block.block_type.as_deref() != Some("input_text") {
                continue;
            }
            let Some(text) = block.text else { continue };
            let trimmed = text.trim();
            if trimmed.is_empty() || is_synthetic_environment_context(trimmed) {
                continue;
            }
            return Some(truncate(trimmed));
        }
    }
    None
}

/// One rollout file as a sidebar row, or `None` when its first line is not
/// a readable `session_meta` yet.
fn session_from_rollout_file(path: &Path) -> Option<SessionMeta> {
    let (session_id, cwd, created_at) = read_session_meta_line(path)?;
    Some(SessionMeta {
        id: session_id,
        agent: AgentId::Codex.as_str().to_string(),
        created_at: created_at.map(|ts| canonicalize_rfc3339(&ts)),
        updated_at: mtime_to_rfc3339(path),
        first_message_preview: first_real_user_message(path),
        custom_title: None,
        summary: None,
        project_path: cwd,
    })
}

pub(crate) fn list_codex_sessions(project_path: &str) -> Result<Vec<SessionMeta>, String> {
    let Some(root) = sessions_root() else {
        return Err("cannot resolve the Codex sessions directory".into());
    };
    // No directory means Codex has never been run — an empty list, not an
    // error, exactly like Claude's and Cursor's providers before their first
    // session.
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(scan_sessions_root(&root, project_path))
}

fn scan_sessions_root(root: &Path, project_path: &str) -> Vec<SessionMeta> {
    let target = canonical(project_path);

    // One conversation can have several rollout files — each resume writes
    // a new one under the same session_id (see module docs). Keep only the
    // most recently modified file per session_id, so the list shows one row
    // per conversation, not one per resume.
    let mut latest_by_session: HashMap<String, (PathBuf, SystemTime)> = HashMap::new();
    for path in list_rollout_files(root) {
        let Some((session_id, cwd, _)) = read_session_meta_line(&path) else {
            continue;
        };
        if canonical(&cwd) != target {
            continue;
        }
        let mtime = fs::metadata(&path)
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match latest_by_session.get(&session_id) {
            Some((_, existing_mtime)) if *existing_mtime >= mtime => {}
            _ => {
                latest_by_session.insert(session_id, (path, mtime));
            }
        }
    }

    let mut out: Vec<SessionMeta> = latest_by_session
        .into_values()
        .filter_map(|(path, _)| session_from_rollout_file(&path))
        .collect();

    // Same ordering contract as Claude's and Cursor's providers, so the
    // merged list does not reshuffle depending on which agent wrote a row.
    out.sort_by(|a, b| {
        ts_key(&b.updated_at)
            .cmp(&ts_key(&a.updated_at))
            .then_with(|| ts_key(&b.created_at).cmp(&ts_key(&a.created_at)))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// Used by `session_watcher.rs` to turn one changed rollout file into a live
/// `session:meta` update, and to decide whether a just-sighted file is a
/// brand-new session (`session:new`). Deliberately the single-file mapping,
/// not the deduplicated list above: a live update is about "here is fresh
/// data for this session", which the frontend applies to whichever tab
/// already holds that `session_id` — it does not need the cross-file merge
/// the Sessions-tab listing does.
pub(crate) fn session_from_rollout(path: &Path) -> Option<SessionMeta> {
    session_from_rollout_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "klaudio-codex-test-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_rollout(
        root: &Path,
        date_path: &str,
        filename: &str,
        lines: &[String],
    ) -> PathBuf {
        let dir = root.join(date_path);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(filename);
        fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    fn session_meta_line(session_id: &str, id: &str, cwd: &Path, timestamp: &str) -> String {
        format!(
            r#"{{"timestamp":"{timestamp}","type":"session_meta","payload":{{"session_id":"{session_id}","id":"{id}","timestamp":"{timestamp}","cwd":"{}","originator":"codex-tui"}}}}"#,
            cwd.display()
        )
    }

    fn legacy_session_meta_line(id: &str, cwd: &Path, timestamp: &str) -> String {
        format!(
            r#"{{"timestamp":"{timestamp}","type":"session_meta","payload":{{"id":"{id}","timestamp":"{timestamp}","cwd":"{}","originator":"codex-tui"}}}}"#,
            cwd.display()
        )
    }

    fn user_message_line(text: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-01-01T00:00:01.000Z","type":"response_item","payload":{{"type":"message","id":"msg_1","role":"user","content":[{{"type":"input_text","text":{}}}]}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    const ENV_CONTEXT: &str =
        "<environment_context><cwd>/x</cwd><shell>zsh</shell></environment_context>";

    #[test]
    fn maps_a_rollout_field_for_field() {
        let root = TempDir::new("map");
        let project = TempDir::new("map-project");
        let path = write_rollout(
            &root.0,
            "2026/09/16",
            "rollout-2026-09-16T15-58-58-id-a.jsonl",
            &[
                session_meta_line("sess-a", "id-a", &project.0, "2026-09-16T20:58:58.877Z"),
                user_message_line(ENV_CONTEXT),
                user_message_line("what does this project do?"),
            ],
        );

        let s = session_from_rollout_file(&path).unwrap();
        assert_eq!(s.id, "sess-a");
        assert_eq!(s.agent, "codex");
        assert!(s.custom_title.is_none());
        assert!(s.summary.is_none());
        assert_eq!(
            s.first_message_preview.as_deref(),
            Some("what does this project do?")
        );
        assert_eq!(s.created_at.as_deref(), Some("2026-09-16T20:58:58.877Z"));
    }

    #[test]
    fn legacy_rollout_without_session_id_falls_back_to_payload_id() {
        let root = TempDir::new("legacy-id");
        let project = TempDir::new("legacy-id-project");
        let path = write_rollout(
            &root.0,
            "2026/06/01",
            "rollout-legacy-id-a.jsonl",
            &[
                legacy_session_meta_line("legacy-id-a", &project.0, "2026-06-01T12:00:00.000Z"),
                user_message_line("old but resumable"),
            ],
        );

        let session = session_from_rollout_file(&path).unwrap();
        assert_eq!(session.id, "legacy-id-a");
    }

    // The exact bug Gate 3 exists to catch: a preview extractor that takes
    // "the first user message" verbatim would show this XML blob.
    #[test]
    fn the_synthetic_environment_context_message_is_never_the_preview() {
        let root = TempDir::new("env-ctx");
        let project = TempDir::new("env-ctx-project");
        let path = write_rollout(
            &root.0,
            "2026/09/16",
            "rollout-x-id-a.jsonl",
            &[
                session_meta_line("sess-a", "id-a", &project.0, "2026-09-16T20:58:58.877Z"),
                user_message_line(ENV_CONTEXT),
            ],
        );

        let s = session_from_rollout_file(&path).unwrap();
        assert!(s.first_message_preview.is_none());
    }

    // The central correctness fix this module exists for: a conversation
    // resumed more than once has one rollout file per resume, each with its
    // own distinct file id, but they all share one session_id. Listing must
    // show exactly one row — not one per resume, and not keyed by the file
    // id `codex resume` does not accept.
    #[test]
    fn collapses_multiple_resumes_of_the_same_session_into_one_row() {
        let root = TempDir::new("resume");
        let project = TempDir::new("resume-project");

        let older = write_rollout(
            &root.0,
            "2026/07/19",
            "rollout-2026-07-19T10-50-28-id-1.jsonl",
            &[
                session_meta_line("sess-stable", "id-1", &project.0, "2026-07-19T15:50:28.000Z"),
                user_message_line(ENV_CONTEXT),
                user_message_line("first question"),
            ],
        );
        let newer = write_rollout(
            &root.0,
            "2026/07/19",
            "rollout-2026-07-19T18-10-11-id-2.jsonl",
            &[
                session_meta_line("sess-stable", "id-2", &project.0, "2026-07-19T23:10:11.000Z"),
                user_message_line(ENV_CONTEXT),
                user_message_line("follow-up question"),
            ],
        );
        // Force a deterministic mtime order regardless of write speed.
        let t_old = SystemTime::now() - std::time::Duration::from_secs(60);
        let t_new = SystemTime::now();
        set_mtime(&older, t_old);
        set_mtime(&newer, t_new);

        let found = scan_sessions_root(&root.0, project.0.to_str().unwrap());
        let ids: Vec<&str> = found.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(found.len(), 1, "expected one row, got ids {ids:?}");
        assert_eq!(found[0].id, "sess-stable");
        assert_eq!(
            found[0].first_message_preview.as_deref(),
            Some("follow-up question"),
            "must reflect the most recently modified rollout, not an arbitrary one"
        );
    }

    #[test]
    fn lists_only_this_projects_sessions_newest_first() {
        let root = TempDir::new("list");
        let mine = TempDir::new("list-mine");
        let other = TempDir::new("list-other");

        let old = write_rollout(
            &root.0,
            "2026/01/01",
            "rollout-old-id-old.jsonl",
            &[session_meta_line("old", "id-old", &mine.0, "2026-01-01T00:00:00.000Z")],
        );
        let new = write_rollout(
            &root.0,
            "2026/01/02",
            "rollout-new-id-new.jsonl",
            &[session_meta_line("new", "id-new", &mine.0, "2026-01-02T00:00:00.000Z")],
        );
        write_rollout(
            &root.0,
            "2026/01/03",
            "rollout-theirs-id-theirs.jsonl",
            &[session_meta_line("theirs", "id-theirs", &other.0, "2026-01-03T00:00:00.000Z")],
        );
        set_mtime(&old, SystemTime::now() - std::time::Duration::from_secs(120));
        set_mtime(&new, SystemTime::now());

        let ids: Vec<String> = scan_sessions_root(&root.0, mine.0.to_str().unwrap())
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["new", "old"]);
    }

    #[test]
    fn a_missing_or_malformed_first_line_is_skipped_not_fatal() {
        let root = TempDir::new("bad");
        let project = TempDir::new("bad-project");
        write_rollout(&root.0, "2026/01/01", "rollout-broken-id-b.jsonl", &["{not json".to_string()]);
        write_rollout(
            &root.0,
            "2026/01/01",
            "rollout-ok-id-ok.jsonl",
            &[session_meta_line("ok", "id-ok", &project.0, "2026-01-01T00:00:00.000Z")],
        );

        let ids: Vec<String> = scan_sessions_root(&root.0, project.0.to_str().unwrap())
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["ok"]);
    }

    #[cfg(unix)]
    fn set_mtime(path: &Path, time: SystemTime) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }
}
