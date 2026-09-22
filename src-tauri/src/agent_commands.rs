//! The commands behind the agent settings panel and the `+` picker: which
//! agents exist and whether they are on, where discovery would find each
//! binary, saving an agent's settings, and minting a session id for agents
//! that can be handed one before they start (`agent::mints_session_ids`).
//!
//! Storage stays in `agent_settings.rs`; this is only the surface the
//! frontend talks to.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::agent::{self, AgentId};
use crate::agent_settings::{self, AgentSettings};
use crate::debug_log;

/// `create-chat` talks to Cursor's backend; this is generous for that and
/// still short enough that a hung CLI shows up as an error on the tab rather
/// than a `+` that silently does nothing.
const CREATE_SESSION_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    id: &'static str,
    display_name: &'static str,
    bin_name: &'static str,
    enabled: bool,
    binary_path: Option<String>,
}

#[tauri::command]
pub fn list_agents() -> Vec<AgentInfo> {
    AgentId::ALL
        .iter()
        .map(|id| {
            let spec = agent::spec(*id);
            let settings = agent_settings::load(*id);
            AgentInfo {
                id: id.as_str(),
                display_name: spec.display_name,
                bin_name: spec.bin_name,
                enabled: settings.enabled,
                binary_path: settings.binary_path,
            }
        })
        .collect()
}

/// Where discovery finds this agent when no path is configured — the
/// placeholder of an empty binary field. Async and off the main thread: it
/// re-runs the login shell and probes each candidate's `--version`.
#[tauri::command]
pub async fn discover_agent_binary(agent_id: String) -> Result<String, String> {
    let id = AgentId::parse(&agent_id)?;
    tauri::async_runtime::spawn_blocking(move || crate::binary::discover(id))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().into_owned())
}

/// The one rule that is not about a single agent: an app with no agent
/// enabled is a window that cannot start anything, and the only way back
/// would be editing `agents.json` by hand.
fn would_disable_the_last_agent(
    id: AgentId,
    enabled: bool,
    is_enabled: impl Fn(AgentId) -> bool,
) -> bool {
    !enabled
        && !AgentId::ALL
            .iter()
            .any(|other| *other != id && is_enabled(*other))
}

#[tauri::command]
pub async fn set_agent_settings(
    agent_id: String,
    enabled: bool,
    binary_path: Option<String>,
) -> Result<(), String> {
    let id = AgentId::parse(&agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if would_disable_the_last_agent(id, enabled, |a| agent_settings::load(a).enabled) {
            return Err("At least one agent has to stay enabled.".to_string());
        }
        let settings = AgentSettings {
            enabled,
            binary_path: binary_path
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty()),
        };
        // Refused at save time rather than at the next spawn: a path that
        // does not answer as this agent is a mistake the user is looking at
        // right now, not one to discover when a tab fails to open.
        if let Some(path) = settings.override_path() {
            if !crate::binary::validate(id, &path) {
                let spec = agent::spec(id);
                return Err(format!(
                    "{} does not run as {} — `{} --version` has to succeed and identify it.",
                    path.display(),
                    spec.display_name,
                    path.display(),
                ));
            }
        }
        agent_settings::save(id, settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A chat id is handed straight to `--resume`; anything that is not shaped
/// like one is a CLI message we misread, not an id.
fn looks_like_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn last_line(stdout: &str) -> Option<&str> {
    stdout.lines().map(str::trim).rfind(|l| !l.is_empty())
}

/// Mints the session id a new tab will resume, for agents that can be given
/// one up front. `None` for agents that pick their own (Claude), whose new
/// tabs are correlated by the watcher instead.
///
/// Runs with the same resolved and scrubbed env a spawn would get, in the
/// project directory: whatever account the project's `.envrc` selects is the
/// one the chat is created under.
#[tauri::command]
pub async fn agent_create_session(
    project_path: String,
    agent_id: String,
) -> Result<Option<String>, String> {
    let id = AgentId::parse(&agent_id)?;
    let Some(args) = agent::create_session_argv(id) else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let spec = agent::spec(id);
        if !agent_settings::load(id).enabled {
            return Err(format!("{} is disabled in the agent settings.", spec.display_name));
        }
        let bin = crate::binary::find_agent_binary(id)?;
        let shell = crate::shell_env::get_user_shell();
        let shell_env = crate::shell_env::load_shell_env(&shell);
        let mut env = crate::project_env::resolve_project_env(&project_path, shell_env, Vec::new())?;
        agent::strip_blocked_env(id, &mut env);

        let stdout = run_with_timeout(&bin, &args, Path::new(&project_path), env)?;
        match last_line(&stdout) {
            Some(line) if looks_like_session_id(line) => Ok(Some(line.to_string())),
            _ => {
                // The output may be an auth prompt or an error message; say
                // that it happened, not what it said.
                debug_log::write(
                    "agent",
                    &format!("{} create-session returned no id ({} bytes)", spec.bin_name, stdout.len()),
                );
                Err(format!(
                    "{} did not return a chat id. Run `{} status` in a terminal to check you are logged in.",
                    spec.display_name, spec.bin_name
                ))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_with_timeout(
    bin: &Path,
    args: &[String],
    cwd: &Path,
    env: Vec<(String, String)>,
) -> Result<String, String> {
    use std::io::Read;

    let mut child = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", bin.display()))?;

    let deadline = Instant::now() + CREATE_SESSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut out);
                }
                if !status.success() {
                    return Err(format!("{} exited with {status}", bin.display()));
                }
                return Ok(out);
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return Err(format!(
                    "{} did not answer within {}s",
                    bin.display(),
                    CREATE_SESSION_TIMEOUT.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_enabled_agent_cannot_be_disabled() {
        assert!(would_disable_the_last_agent(AgentId::Claude, false, |a| a == AgentId::Claude));
    }

    #[test]
    fn an_agent_can_be_disabled_while_another_stays_on() {
        assert!(!would_disable_the_last_agent(
            AgentId::Claude,
            false,
            |_| true
        ));
    }

    #[test]
    fn enabling_is_never_blocked() {
        assert!(!would_disable_the_last_agent(AgentId::Cursor, true, |_| {
            false
        }));
    }

    #[test]
    fn reads_the_id_create_chat_prints() {
        let out = "41a591a0-5a49-407f-bc6b-4c49f5057c27\n";
        let line = last_line(out).unwrap();
        assert!(looks_like_session_id(line));
        assert_eq!(line, "41a591a0-5a49-407f-bc6b-4c49f5057c27");
    }

    #[test]
    fn a_message_is_not_mistaken_for_an_id() {
        assert!(!looks_like_session_id(
            "Please log in with `cursor-agent login`"
        ));
        assert!(!looks_like_session_id(""));
    }
}
