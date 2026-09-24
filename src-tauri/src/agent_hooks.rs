//! Cursor `stop` hooks, delivered on a per-install socket.
//!
//! `cursor-agent` runs `~/.cursor/hooks.json` in every terminal, including
//! iTerm. The script is a no-op unless `KLAUDIO_HOOK_SOCK` names a live
//! socket, which only a Klaudio Cursor child receives. The listener maps
//! `KLAUDIO_PTY_ID` to the live session and emits the existing
//! `session:complete` event. The payload is never logged: it can carry the
//! user's email.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::AgentId;
use crate::debug_log;
use crate::local_socket::{self, bind_exclusive};
use crate::session_watcher::SessionCompletePayload;

const MAX_MESSAGE: u64 = 64 * 1024;

static HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn hook_active() -> bool {
    HOOK_ACTIVE.load(Ordering::Relaxed)
}

pub fn socket_path() -> Option<PathBuf> {
    local_socket::cache_socket("hook")
}

pub fn script_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("klaudio-panels/bin/klaudio-cursor-hook"))
}

/// `#!/bin/sh`. Always prints `{}` and exits 0. No temp file. Outside a
/// Klaudio PTY the socket check fails and the script costs one `test`.
pub const HOOK_SCRIPT: &str = r#"#!/bin/sh
# Klaudio Panels — cursor-agent stop hook. Inert unless this process is a
# Klaudio Cursor tab (KLAUDIO_HOOK_SOCK set). Generated at app boot; edits
# here are overwritten.
if [ -n "$KLAUDIO_HOOK_SOCK" ] && [ -S "$KLAUDIO_HOOK_SOCK" ] && command -v nc >/dev/null 2>&1; then
  { printf '%s\n' "$KLAUDIO_PTY_ID"; cat; } | nc -U -w 1 "$KLAUDIO_HOOK_SOCK" >/dev/null 2>&1
fi
printf '{}\n'
exit 0
"#;

/// What the listener knows about one live PTY. Built from `PtyState` at
/// delivery time; the decision itself does not touch the map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPty {
    pub is_cursor: bool,
    pub project_path: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Complete {
        project_path: String,
        session_id: String,
        stop_reason: String,
    },
    Drop(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHook {
    pub pty_id: String,
    pub conversation_id: String,
    pub status: String,
    pub hook_event_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    Oversize,
    Garbage,
    MissingField,
}

pub fn parse_hook_message(buf: &[u8]) -> Result<ParsedHook, ParseError> {
    if buf.len() as u64 > MAX_MESSAGE {
        return Err(ParseError::Oversize);
    }
    let text = std::str::from_utf8(buf).map_err(|_| ParseError::Garbage)?;
    let Some((pty_id, rest)) = text.split_once('\n') else {
        return Err(ParseError::Garbage);
    };
    let pty_id = pty_id.trim();
    if pty_id.is_empty() {
        return Err(ParseError::MissingField);
    }
    let body = rest.trim();
    if body.is_empty() {
        return Err(ParseError::MissingField);
    }
    let payload: HookJson = serde_json::from_str(body).map_err(|_| ParseError::Garbage)?;
    let conversation_id = payload
        .conversation_id
        .filter(|s| !s.is_empty())
        .ok_or(ParseError::MissingField)?;
    Ok(ParsedHook {
        pty_id: pty_id.to_string(),
        conversation_id,
        status: payload.status.unwrap_or_default(),
        hook_event_name: payload.hook_event_name,
    })
}

#[derive(Deserialize)]
struct HookJson {
    conversation_id: Option<String>,
    status: Option<String>,
    hook_event_name: Option<String>,
}

pub fn route(open: Option<&OpenPty>, parsed: &ParsedHook) -> Route {
    if parsed
        .hook_event_name
        .as_deref()
        .is_some_and(|n| n != "stop")
    {
        return Route::Drop("not a stop event");
    }
    let Some(open) = open else {
        return Route::Drop("unknown pty");
    };
    if !open.is_cursor {
        return Route::Drop("not a cursor pty");
    }
    match &open.session_id {
        Some(id) if id == &parsed.conversation_id => Route::Complete {
            project_path: open.project_path.clone(),
            session_id: id.clone(),
            stop_reason: parsed.status.clone(),
        },
        _ => Route::Drop("conversation id does not match"),
    }
}

/// Add the two hook vars for a Cursor child, and only when this install
/// owns the socket. Claude, the shell and editor PTYs never see them.
pub fn apply_cursor_hook_env(
    is_cursor: bool,
    active: bool,
    sock: Option<&str>,
    pty_id: &str,
    env: &mut Vec<(String, String)>,
) {
    if !is_cursor || !active {
        return;
    }
    let Some(sock) = sock else { return };
    env.push(("KLAUDIO_HOOK_SOCK".into(), sock.to_string()));
    env.push(("KLAUDIO_PTY_ID".into(), pty_id.to_string()));
}

pub fn install(app: AppHandle) {
    if let Err(e) = write_script() {
        debug_log::write("hooks", &format!("script install failed: {e}"));
    }
    let Some(path) = socket_path() else { return };
    match bind_exclusive(&path) {
        Ok(Some(listener)) => {
            HOOK_ACTIVE.store(true, Ordering::Relaxed);
            debug_log::write("hooks", "cursor hook listener ready");
            std::thread::spawn(move || accept_loop(app, listener));
        }
        Ok(None) => {
            debug_log::write(
                "hooks",
                "another Klaudio owns this install's hook socket; not listening",
            );
        }
        Err(e) => debug_log::write("hooks", &format!("listener failed: {e}")),
    }
}

fn write_script() -> std::io::Result<()> {
    let Some(path) = script_path() else {
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, HOOK_SCRIPT)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

fn accept_loop(app: AppHandle, listener: UnixListener) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let app = app.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if stream.take(MAX_MESSAGE).read_to_end(&mut buf).is_err() {
                debug_log::write("hooks", "hook event dropped: read failed");
                return;
            }
            deliver(&app, &buf);
        });
    }
}

fn deliver(app: &AppHandle, buf: &[u8]) {
    let parsed = match parse_hook_message(buf) {
        Ok(p) => p,
        Err(ParseError::Oversize) => {
            debug_log::write("hooks", "hook event dropped: oversize");
            return;
        }
        Err(ParseError::Garbage) => {
            debug_log::write("hooks", "hook event dropped: garbage");
            return;
        }
        Err(ParseError::MissingField) => {
            debug_log::write("hooks", "hook event dropped: missing field");
            return;
        }
    };
    let open = lookup_pty(app, &parsed.pty_id);
    match route(open.as_ref(), &parsed) {
        Route::Complete {
            project_path,
            session_id,
            stop_reason,
        } => {
            let _ = app.emit(
                "session:complete",
                SessionCompletePayload {
                    agent: AgentId::Cursor.as_str().to_string(),
                    project_path,
                    session_id,
                    stop_reason,
                    preview: None,
                },
            );
            debug_log::write("hooks", "cursor stop delivered");
        }
        Route::Drop(reason) => {
            debug_log::write("hooks", &format!("hook event dropped: {reason}"));
        }
    }
}

fn lookup_pty(app: &AppHandle, pty_id: &str) -> Option<OpenPty> {
    let state = app.state::<crate::pty::PtyState>();
    let sessions = state.sessions.lock().ok()?;
    let session = sessions.get(pty_id)?;
    Some(OpenPty {
        is_cursor: session.agent == Some(AgentId::Cursor),
        project_path: session.project_path.clone(),
        session_id: session.session_id.clone(),
    })
}

/// User-level Cursor hooks file. Callers that must not touch the real
/// home pass their own path into `cursor_hooks` instead.
pub fn user_hooks_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor/hooks.json"))
}

pub fn user_hooks_command() -> Option<String> {
    script_path().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(conv: &str) -> ParsedHook {
        ParsedHook {
            pty_id: "pty-1".into(),
            conversation_id: conv.into(),
            status: "completed".into(),
            hook_event_name: Some("stop".into()),
        }
    }

    fn cursor(session: Option<&str>) -> OpenPty {
        OpenPty {
            is_cursor: true,
            project_path: "/proj".into(),
            session_id: session.map(str::to_string),
        }
    }

    #[test]
    fn parses_a_well_formed_message() {
        let msg = b"pty-1\n{\"conversation_id\":\"chat-9\",\"status\":\"completed\",\"hook_event_name\":\"stop\",\"user_email\":\"a@b.c\"}";
        let p = parse_hook_message(msg).unwrap();
        assert_eq!(p.pty_id, "pty-1");
        assert_eq!(p.conversation_id, "chat-9");
        assert_eq!(p.status, "completed");
        assert_eq!(p.hook_event_name.as_deref(), Some("stop"));
    }

    #[test]
    fn rejects_oversize_garbage_and_missing_fields() {
        let big = vec![b'x'; (MAX_MESSAGE as usize) + 1];
        assert_eq!(parse_hook_message(&big), Err(ParseError::Oversize));
        assert_eq!(
            parse_hook_message(b"not a message"),
            Err(ParseError::Garbage)
        );
        assert_eq!(
            parse_hook_message(b"pty-1\n{\"status\":\"completed\"}"),
            Err(ParseError::MissingField)
        );
        assert_eq!(parse_hook_message(&[0xff, 0xfe]), Err(ParseError::Garbage));
    }

    #[test]
    fn routes_only_a_matching_cursor_pty() {
        assert!(matches!(
            route(None, &parsed("chat")),
            Route::Drop("unknown pty")
        ));
        let other = OpenPty {
            is_cursor: false,
            project_path: "/proj".into(),
            session_id: Some("chat".into()),
        };
        assert!(matches!(
            route(Some(&other), &parsed("chat")),
            Route::Drop("not a cursor pty")
        ));
        assert!(matches!(
            route(Some(&cursor(Some("other"))), &parsed("chat")),
            Route::Drop("conversation id does not match")
        ));
        match route(Some(&cursor(Some("chat"))), &parsed("chat")) {
            Route::Complete {
                project_path,
                session_id,
                stop_reason,
            } => {
                assert_eq!(project_path, "/proj");
                assert_eq!(session_id, "chat");
                assert_eq!(stop_reason, "completed");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn hook_env_is_cursor_only() {
        let mut claude = vec![("PATH".into(), "/usr/bin".into())];
        apply_cursor_hook_env(false, true, Some("/tmp/h.sock"), "pty-1", &mut claude);
        assert!(claude.iter().all(|(k, _)| !k.starts_with("KLAUDIO_")));

        let mut cursor = vec![("PATH".into(), "/usr/bin".into())];
        apply_cursor_hook_env(true, false, Some("/tmp/h.sock"), "pty-1", &mut cursor);
        assert!(cursor.iter().all(|(k, _)| !k.starts_with("KLAUDIO_")));

        apply_cursor_hook_env(true, true, Some("/tmp/h.sock"), "pty-1", &mut cursor);
        assert!(cursor
            .iter()
            .any(|(k, v)| k == "KLAUDIO_HOOK_SOCK" && v == "/tmp/h.sock"));
        assert!(cursor
            .iter()
            .any(|(k, v)| k == "KLAUDIO_PTY_ID" && v == "pty-1"));
    }

    #[test]
    fn the_script_always_exits_clean_and_stays_off_disk() {
        assert!(HOOK_SCRIPT.starts_with("#!/bin/sh\n"));
        assert!(HOOK_SCRIPT.contains("printf '{}\\n'"));
        assert!(HOOK_SCRIPT.contains("exit 0"));
        assert!(HOOK_SCRIPT.contains("-S \"$KLAUDIO_HOOK_SOCK\""));
        assert!(HOOK_SCRIPT.contains("nc -U -w 1"));
        assert!(!HOOK_SCRIPT.contains("mktemp"));
        let dir = std::env::temp_dir().join(format!("klaudio-hook-script-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("klaudio-cursor-hook");
        std::fs::write(&path, HOOK_SCRIPT).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let out = std::process::Command::new(&path)
            .env_clear()
            .output()
            .expect("run");
        assert!(out.status.success());
        assert_eq!(out.stdout, b"{}\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
