//! Cursor's session provider (`agent::list_sessions`) — the `cursor-agent`
//! counterpart of `sessions.rs`, and read-only for the same reason
//! (decision #5).
//!
//! Each chat is a directory, `~/.cursor/chats/<md5(cwd)>/<chatId>/`, holding a
//! `meta.json` (`cwd`, `title`, `createdAtMs`, `updatedAtMs`,
//! `hasConversation`) and a `prompt_history.json`, plus a `store.db` once the
//! chat has content. That database is an undocumented blob store the agent
//! writes live with WAL enabled; everything the sidebar needs is already in
//! the two JSON files, so it is never opened.
//!
//! The directory name is `md5(cwd)`, but it is not used to find a project:
//! Cursor hashes the *resolved* path (`/tmp/x` is stored as `/private/tmp/x`),
//! so hashing the path Klaudio was handed can miss. Like Claude's provider,
//! this scans the root and matches on the `cwd` each chat records — there are
//! as many directories as projects ever opened in Cursor, and reading one
//! small `meta.json` per directory to rule it out is cheap.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;

use crate::agent::AgentId;
use crate::sessions::{canonical, truncate, ts_key, SessionMeta};

pub(crate) const META_FILE: &str = "meta.json";
const PROMPT_HISTORY_FILE: &str = "prompt_history.json";

/// Default root only, mirroring Claude's watcher: `CURSOR_DATA_DIR` moves it,
/// and following that is the Cursor-profiles follow-up (see PRP 024), not
/// this provider.
pub(crate) fn chats_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor/chats"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatMeta {
    created_at_ms: Option<i64>,
    updated_at_ms: Option<i64>,
    /// False for a chat that was opened and never used. Cursor deletes most
    /// of those when the agent exits, but not all of them — and one it left
    /// behind cannot be resumed into anything, so it is never a row.
    #[serde(default)]
    has_conversation: bool,
    title: Option<String>,
    cwd: Option<String>,
}

pub(crate) fn read_meta(chat_dir: &Path) -> Option<ChatMeta> {
    let raw = fs::read_to_string(chat_dir.join(META_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn ms_to_rfc3339(ms: Option<i64>) -> Option<String> {
    let dt: DateTime<Utc> = DateTime::from_timestamp_millis(ms?)?;
    Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// `/exit`, `/model`, `/plan` — typed into the prompt bar and recorded in the
/// history like anything else, but not what the conversation is about. A
/// prompt that merely *starts* with a path (`/Users/me/x.png what is this`)
/// is not one: its first word has a second slash.
fn is_slash_command(prompt: &str) -> bool {
    let first = prompt.split_whitespace().next().unwrap_or("");
    first.len() > 1
        && first.starts_with('/')
        && first[1..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The first thing the user asked. `prompt_history.json` is newest-first, so
/// that is the *last* entry that is not a slash command.
fn first_prompt(chat_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(chat_dir.join(PROMPT_HISTORY_FILE)).ok()?;
    let history: Vec<String> = serde_json::from_str(&raw).ok()?;
    history
        .iter()
        .rev()
        .map(|p| p.trim())
        .find(|p| !p.is_empty() && !is_slash_command(p))
        .map(truncate)
}

/// One chat directory as a sidebar row, or `None` when it is not one: no
/// conversation yet, or a `meta.json` we cannot read.
pub(crate) fn session_from_chat(chat_dir: &Path) -> Option<SessionMeta> {
    let meta = read_meta(chat_dir)?;
    if !meta.has_conversation {
        return None;
    }
    let id = chat_dir.file_name()?.to_str()?.to_string();
    let cwd = meta.cwd?;
    Some(SessionMeta {
        id,
        agent: AgentId::Cursor.as_str().to_string(),
        created_at: ms_to_rfc3339(meta.created_at_ms),
        updated_at: ms_to_rfc3339(meta.updated_at_ms),
        first_message_preview: first_prompt(chat_dir),
        // Cursor's auto-generated title is the only title it has. Filing it
        // as `custom_title` rather than also as `summary` keeps it from
        // rendering twice wherever both are shown.
        custom_title: meta.title.filter(|t| !t.trim().is_empty()),
        summary: None,
        project_path: cwd,
    })
}

pub(crate) fn list_cursor_sessions(project_path: &str) -> Result<Vec<SessionMeta>, String> {
    let Some(root) = chats_root() else {
        return Err("cannot resolve the Cursor chats directory".into());
    };
    // No directory means Cursor has never been run here — an empty list, not
    // an error, exactly like Claude's provider before its first session.
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(scan_chats_root(&root, project_path))
}

fn scan_chats_root(root: &Path, project_path: &str) -> Vec<SessionMeta> {
    let target = canonical(project_path);
    let mut out = Vec::new();

    let Ok(hash_dirs) = fs::read_dir(root) else {
        return out;
    };
    for hash_dir in hash_dirs.flatten() {
        let hash_path = hash_dir.path();
        if !hash_path.is_dir() {
            continue;
        }
        let Ok(chats) = fs::read_dir(&hash_path) else {
            continue;
        };
        let chat_dirs: Vec<PathBuf> = chats
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();

        // Every chat under one hash shares its `cwd`, so the first readable
        // one — used or not — decides whether this project owns the lot.
        let owner = chat_dirs
            .iter()
            .find_map(|d| read_meta(d).and_then(|m| m.cwd));
        match owner {
            Some(cwd) if canonical(&cwd) == target => {}
            _ => continue,
        }

        out.extend(chat_dirs.iter().filter_map(|d| session_from_chat(d)));
    }

    // Same ordering contract as Claude's provider, so the merged list does
    // not reshuffle depending on which agent wrote a row.
    out.sort_by(|a, b| {
        ts_key(&b.updated_at)
            .cmp(&ts_key(&a.updated_at))
            .then_with(|| ts_key(&b.created_at).cmp(&ts_key(&a.created_at)))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
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
                "klaudio-cursor-test-{label}-{}-{nanos}",
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

    fn write_chat(root: &Path, hash: &str, id: &str, meta: &str, history: Option<&str>) -> PathBuf {
        let dir = root.join(hash).join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(META_FILE), meta).unwrap();
        if let Some(h) = history {
            fs::write(dir.join(PROMPT_HISTORY_FILE), h).unwrap();
        }
        dir
    }

    fn meta(cwd: &Path, has_conversation: bool, title: Option<&str>, updated: i64) -> String {
        let title = title
            .map(|t| format!(r#""title":"{t}","#))
            .unwrap_or_default();
        format!(
            r#"{{"schemaVersion":1,"createdAtMs":1789928343396,"hasConversation":{has_conversation},{title}"updatedAtMs":{updated},"cwd":"{}"}}"#,
            cwd.display()
        )
    }

    #[test]
    fn maps_a_used_chat_field_for_field() {
        let root = TempDir::new("map");
        let project = TempDir::new("map-project");
        let dir = write_chat(
            &root.0,
            "h1",
            "chat-1",
            &meta(
                &project.0,
                true,
                Some("Project Diff Analysis"),
                1790094370140,
            ),
            Some(r#"["/exit", "later question", "what is this project about"]"#),
        );

        let s = session_from_chat(&dir).unwrap();
        assert_eq!(s.id, "chat-1");
        assert_eq!(s.agent, "cursor");
        assert_eq!(s.custom_title.as_deref(), Some("Project Diff Analysis"));
        assert!(s.summary.is_none());
        assert_eq!(
            s.first_message_preview.as_deref(),
            Some("what is this project about")
        );
        assert_eq!(s.updated_at.as_deref(), Some("2026-09-22T16:26:10.140Z"));
    }

    // Cursor leaves opened-but-unused chats behind; a third of the chats on a
    // real machine were these. They cannot be resumed into anything.
    #[test]
    fn a_chat_without_a_conversation_is_not_a_row() {
        let root = TempDir::new("empty");
        let project = TempDir::new("empty-project");
        let dir = write_chat(&root.0, "h1", "c", &meta(&project.0, false, None, 1), None);
        assert!(session_from_chat(&dir).is_none());
    }

    #[test]
    fn preview_skips_slash_commands_but_not_prompts_that_start_with_a_path() {
        let root = TempDir::new("slash");
        let project = TempDir::new("slash-project");
        let dir = write_chat(
            &root.0,
            "h1",
            "c",
            &meta(&project.0, true, None, 1),
            Some(r#"["hi", "/Users/me/shot.png what is this", "/model", "/plan"]"#),
        );
        assert_eq!(
            session_from_chat(&dir)
                .unwrap()
                .first_message_preview
                .as_deref(),
            Some("/Users/me/shot.png what is this")
        );
    }

    #[test]
    fn lists_only_this_projects_chats_newest_first() {
        let root = TempDir::new("list");
        let mine = TempDir::new("list-mine");
        let other = TempDir::new("list-other");
        write_chat(
            &root.0,
            "a",
            "old",
            &meta(&mine.0, true, Some("Old"), 1_000),
            None,
        );
        write_chat(
            &root.0,
            "a",
            "new",
            &meta(&mine.0, true, Some("New"), 2_000),
            None,
        );
        write_chat(
            &root.0,
            "a",
            "unused",
            &meta(&mine.0, false, None, 3_000),
            None,
        );
        write_chat(
            &root.0,
            "b",
            "theirs",
            &meta(&other.0, true, Some("Theirs"), 9_000),
            None,
        );

        let ids: Vec<String> = scan_chats_root(&root.0, mine.0.to_str().unwrap())
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["new", "old"]);
    }

    // The reason the hash is never trusted: Cursor records the resolved path,
    // so a project reached through a symlink must still find its chats.
    #[cfg(unix)]
    #[test]
    fn matches_a_project_reached_through_a_symlink() {
        let root = TempDir::new("link");
        let real = TempDir::new("link-real");
        let links = TempDir::new("link-dir");
        let link = links.0.join("alias");
        std::os::unix::fs::symlink(&real.0, &link).unwrap();
        let resolved = real.0.canonicalize().unwrap();
        write_chat(
            &root.0,
            "whatever",
            "c",
            &meta(&resolved, true, None, 1),
            None,
        );

        let found = scan_chats_root(&root.0, link.to_str().unwrap());
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn a_missing_or_malformed_meta_is_skipped_not_fatal() {
        let root = TempDir::new("bad");
        let project = TempDir::new("bad-project");
        write_chat(&root.0, "h", "broken", "{not json", None);
        write_chat(&root.0, "h", "ok", &meta(&project.0, true, None, 1), None);

        let ids: Vec<String> = scan_chats_root(&root.0, project.0.to_str().unwrap())
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["ok"]);
    }
}
