//! Per-agent settings that have to be readable by Rust *at spawn time*:
//! whether an agent is offered at all, and an explicit binary path that wins
//! over discovery.
//!
//! Every other preference in this app lives in `localStorage` and is pushed
//! to the backend when the frontend mounts — `clipboard_set_enabled` is the
//! pattern. These two cannot follow it. Discovery is a heuristic and it will
//! be wrong for someone: Cursor's installer alone writes two names for the
//! same binary (`cursor-agent` and the generic `agent`, which another CLI can
//! legitimately own), while `cursor` is a third thing that launches the IDE.
//! The override that fixes that decides *which executable we run*, so it
//! cannot arrive after the first spawn.
//!
//! Decision #6 reserves app settings for SQLite. There is no SQLite in this
//! project and never has been, so this is a plain JSON file built from
//! dependencies we already have — see CLAUDE.md.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::agent::AgentId;

const FILE_NAME: &str = "agents.json";

/// One agent's settings as the rest of the app sees them: every field
/// resolved, nothing left to default.
#[derive(Debug, Clone)]
pub struct AgentSettings {
    pub enabled: bool,
    pub binary_path: Option<String>,
}

/// What is actually in the file. `enabled` stays optional here so that "the
/// user never touched this switch" is distinguishable from "the user turned
/// it on" — the first means the agent's own default
/// (`agent::enabled_by_default`), which is not the same for every agent.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(default)]
    binary_path: Option<String>,
}

fn resolve(id: AgentId, stored: Option<Stored>) -> AgentSettings {
    let stored = stored.unwrap_or_default();
    AgentSettings {
        enabled: stored.enabled.unwrap_or_else(|| crate::agent::enabled_by_default(id)),
        binary_path: stored.binary_path,
    }
}

impl AgentSettings {
    /// The configured override, if it is actually a path. A blank string is
    /// what a settings field produces once the user clears it, and it means
    /// "go back to discovery" — not "run the empty string".
    pub fn override_path(&self) -> Option<PathBuf> {
        self.binary_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    }
}

pub fn settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("klaudio-panels").join(FILE_NAME))
}

/// Settings for one agent. A missing file, a missing key, a missing field and
/// an unparseable file all read as that agent's defaults — its own
/// `enabled_by_default`, and discover the binary. This must never be the
/// reason someone cannot start a session, so there is no error path out of
/// here.
pub fn load(id: AgentId) -> AgentSettings {
    resolve(id, load_all().remove(id.as_str()))
}

/// Serializes every read-modify-write of the file. Two saves racing would
/// each read the old map and the second write would silently undo the first.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Replaces one agent's settings, leaving every other key in the file as it
/// was — including agents this build does not know, so a downgrade followed
/// by an upgrade does not lose them. Written to a sibling file and renamed
/// over the original: a crash mid-write must leave the old settings, never
/// half a JSON document that `load` would read as "all defaults".
pub fn save(id: AgentId, settings: AgentSettings) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "agent settings lock poisoned")?;
    let path = settings_path().ok_or("cannot resolve the app config directory")?;
    let dir = path.parent().ok_or("settings path has no parent directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let mut all = load_all();
    all.insert(
        id.as_str().to_string(),
        Stored {
            enabled: Some(settings.enabled),
            binary_path: settings.binary_path,
        },
    );
    let json = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

fn load_all() -> HashMap<String, Stored> {
    let Some(path) = settings_path() else {
        return HashMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    match serde_json::from_str(&raw) {
        Ok(map) => map,
        Err(e) => {
            crate::debug_log::write("agent", &format!("{FILE_NAME} could not be parsed: {e}"));
            HashMap::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> HashMap<String, Stored> {
        serde_json::from_str(raw).unwrap()
    }

    fn settings(raw: &str, id: AgentId) -> AgentSettings {
        resolve(id, parse(raw).remove(id.as_str()))
    }

    #[test]
    fn absent_fields_default_to_the_agents_own_default_and_discovery() {
        let s = settings(r#"{ "claude": {} }"#, AgentId::Claude);
        assert!(s.enabled);
        assert!(s.override_path().is_none());
    }

    // An update must not start offering an agent nobody asked for: with no
    // entry at all, Cursor is off and Claude — every pre-024 install — is on.
    #[test]
    fn a_new_agent_is_opt_in_and_claude_stays_on() {
        assert!(settings("{}", AgentId::Claude).enabled);
        assert!(!settings("{}", AgentId::Cursor).enabled);
        assert!(!settings(r#"{ "cursor": { "binaryPath": "/x" } }"#, AgentId::Cursor).enabled);
    }

    #[test]
    fn an_explicit_choice_beats_the_default_either_way() {
        assert!(settings(r#"{ "cursor": { "enabled": true } }"#, AgentId::Cursor).enabled);
        assert!(!settings(r#"{ "claude": { "enabled": false } }"#, AgentId::Claude).enabled);
    }

    #[test]
    fn reads_an_explicit_path() {
        let s = settings(
            r#"{ "claude": { "enabled": true, "binaryPath": "/opt/bin/claude" } }"#,
            AgentId::Claude,
        );
        assert_eq!(s.override_path(), Some(PathBuf::from("/opt/bin/claude")));
    }

    #[test]
    fn a_cleared_field_means_discovery_not_an_empty_path() {
        let s = settings(r#"{ "claude": { "binaryPath": "   " } }"#, AgentId::Claude);
        assert!(s.override_path().is_none());
    }

    #[test]
    fn disabled_survives_the_round_trip() {
        let map = parse(r#"{ "claude": { "enabled": false } }"#);
        let back = serde_json::to_string(&map).unwrap();
        assert!(back.contains("\"enabled\":false"));
        // The field the panel writes must keep its camelCase spelling.
        assert!(back.contains("binaryPath"));
    }

    #[test]
    fn an_unknown_agent_key_is_simply_not_ours() {
        let map = parse(r#"{ "codex": { "enabled": false } }"#);
        assert!(!map.contains_key("claude"));
    }
}
