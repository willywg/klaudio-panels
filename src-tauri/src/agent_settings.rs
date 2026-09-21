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

use serde::{Deserialize, Serialize};

use crate::agent::AgentId;

const FILE_NAME: &str = "agents.json";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default)]
    pub binary_path: Option<String>,
}

fn enabled_default() -> bool {
    true
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            binary_path: None,
        }
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
/// an unparseable file all read as the default — enabled, discover the
/// binary. This must never be the reason someone cannot start a session, so
/// there is no error path out of here.
pub fn load(id: AgentId) -> AgentSettings {
    load_all().remove(id.as_str()).unwrap_or_default()
}

fn load_all() -> HashMap<String, AgentSettings> {
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

    fn parse(raw: &str) -> HashMap<String, AgentSettings> {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn absent_fields_default_to_enabled_and_discovered() {
        let map = parse(r#"{ "claude": {} }"#);
        let s = map.get("claude").unwrap();
        assert!(s.enabled);
        assert!(s.override_path().is_none());
    }

    #[test]
    fn reads_an_explicit_path() {
        let map = parse(r#"{ "claude": { "enabled": true, "binaryPath": "/opt/bin/claude" } }"#);
        assert_eq!(
            map["claude"].override_path(),
            Some(PathBuf::from("/opt/bin/claude"))
        );
    }

    #[test]
    fn a_cleared_field_means_discovery_not_an_empty_path() {
        let map = parse(r#"{ "claude": { "binaryPath": "   " } }"#);
        assert!(map["claude"].override_path().is_none());
    }

    #[test]
    fn disabled_survives_the_round_trip() {
        let map = parse(r#"{ "claude": { "enabled": false } }"#);
        assert!(!map["claude"].enabled);
        let back = serde_json::to_string(&map).unwrap();
        assert!(back.contains("\"enabled\":false"));
        // The field the panel will write must keep its camelCase spelling.
        assert!(back.contains("binaryPath"));
    }

    #[test]
    fn an_unknown_agent_key_is_simply_not_ours() {
        let map = parse(r#"{ "cursor": { "enabled": false } }"#);
        assert!(!map.contains_key("claude"));
    }
}
