//! The agent registry — the one place that knows an agent exists.
//!
//! Adding an agent means adding a variant to [`AgentId`] and answering, in
//! the `match` arms below, the questions every agent has to answer: where its
//! binary lives, how it is started, what env it needs, where its sessions are
//! kept, which directory to watch for them, and whether it has a per-project
//! account concept.
//!
//! Enum dispatch rather than `Box<dyn SessionProvider>` on purpose. Two
//! implementations do not justify dynamic dispatch, and the exhaustive match
//! *is* the feature: a new variant makes the compiler enumerate every
//! question the new agent has not answered yet. A trait object would let one
//! be forgotten silently.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::sessions::SessionMeta;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    Claude,
}

impl AgentId {
    pub const ALL: &'static [AgentId] = &[AgentId::Claude];

    pub fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
        }
    }

    /// Parses the id the frontend sends. Unknown ids are an error rather than
    /// a silent fallback to Claude — a tab whose agent we cannot name is a
    /// tab we cannot spawn correctly, and guessing would run the wrong CLI
    /// against someone's project.
    pub fn parse(s: &str) -> Result<Self, String> {
        Self::ALL
            .iter()
            .copied()
            .find(|a| a.as_str() == s)
            .ok_or_else(|| format!("unknown agent id: {s}"))
    }
}

/// How a session is started. The argv lives here, in Rust, so no caller has
/// to know that Claude spells resume `--resume` — the next agent may not.
#[derive(Debug, Clone)]
pub enum Launch {
    New,
    Resume(String),
}

pub struct AgentSpec {
    pub id: AgentId,
    pub display_name: &'static str,
    /// Executable name, looked up on the hydrated login-shell PATH.
    pub bin_name: &'static str,
    /// What to say when discovery comes up empty. Owned by the agent so a
    /// missing binary never advises installing a different CLI.
    pub not_found: &'static str,
}

static CLAUDE: AgentSpec = AgentSpec {
    id: AgentId::Claude,
    display_name: "Claude Code",
    bin_name: "claude",
    not_found: "Claude Code CLI not found. Install with `npm i -g @anthropic-ai/claude-code`, \
                or point Klaudio at it explicitly in the agent settings.",
};

pub fn spec(id: AgentId) -> &'static AgentSpec {
    match id {
        AgentId::Claude => &CLAUDE,
    }
}

/// Paths this agent's own installer is known to write, tried before any PATH
/// lookup. Anthropic's installer drops the newest build in these two, and
/// `which` would otherwise pick up a stale Homebrew or npm copy that happens
/// to sit earlier on PATH.
pub fn installer_candidates(id: AgentId) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    match id {
        AgentId::Claude => vec![
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
        ],
    }
}

/// Paths to try only after the PATH lookups have failed — package managers
/// and version-manager shims. Node version managers are listed only for
/// agents actually distributed as node packages; an agent shipped as a
/// single binary has no business being looked for under `~/.nvm`.
pub fn fallback_candidates(id: AgentId) -> Vec<PathBuf> {
    match id {
        AgentId::Claude => {
            let mut out = vec![
                PathBuf::from("/opt/homebrew/bin/claude"),
                PathBuf::from("/usr/local/bin/claude"),
                PathBuf::from("/usr/bin/claude"),
            ];
            if let Some(home) = dirs::home_dir() {
                out.extend([
                    home.join(".bun/bin/claude"),
                    home.join(".volta/bin/claude"),
                    home.join(".asdf/shims/claude"),
                ]);
                let nvm_root = home.join(".nvm/versions/node");
                if let Ok(entries) = std::fs::read_dir(&nvm_root) {
                    for entry in entries.flatten() {
                        out.push(entry.path().join("bin/claude"));
                    }
                }
            }
            out
        }
    }
}

pub fn argv(id: AgentId, launch: &Launch) -> Vec<String> {
    match (id, launch) {
        (AgentId::Claude, Launch::New) => Vec::new(),
        (AgentId::Claude, Launch::Resume(session_id)) => {
            vec!["--resume".to_string(), session_id.clone()]
        }
    }
}

/// Env this agent needs on top of the project env every PTY child gets.
pub fn extra_env(id: AgentId) -> Vec<(String, String)> {
    match id {
        // Advertise warp's CLI-agent protocol so the warp@claude-code-warp
        // plugin emits structured OSC 777 events instead of falling back to
        // its "install Warp" legacy message. The plugin's gate is in
        // `should-use-structured.sh`: it requires both env vars to be set,
        // and rejects WARP_CLIENT_VERSION strings matching their broken
        // *stable*/*preview*/*dev* releases. Our value avoids those
        // substrings entirely, so the gate is bypassed and we get events.
        AgentId::Claude => vec![
            ("WARP_CLI_AGENT_PROTOCOL_VERSION".to_string(), "1".to_string()),
            (
                "WARP_CLIENT_VERSION".to_string(),
                format!("klaudio-panels-{}", env!("CARGO_PKG_VERSION")),
            ),
        ],
    }
}

/// Whether this agent has a per-project account concept that Klaudio has to
/// namespace sessions by. Claude's is `CLAUDE_CONFIG_DIR`, resolved through
/// direnv (decision #13). An agent that has no equivalent is always on the
/// `"default"` profile — which cannot collide with Claude's `"default"`,
/// because the agent id is a separate segment of every stored key.
pub fn supports_profiles(id: AgentId) -> bool {
    match id {
        AgentId::Claude => true,
    }
}

pub fn list_sessions(id: AgentId, project_path: &str) -> Result<Vec<SessionMeta>, String> {
    match id {
        AgentId::Claude => crate::sessions::list_claude_sessions(project_path),
    }
}

/// The directory whose changes mean "a session of this agent changed".
/// Claude's moves with `CLAUDE_CONFIG_DIR`, so this is the default root
/// only — the watcher has always been single-root (decision #13's open
/// follow-up) and this PRP does not change that.
pub fn watch_root(id: AgentId) -> Option<PathBuf> {
    match id {
        AgentId::Claude => dirs::home_dir().map(|h| h.join(".claude/projects")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_ids_and_rejects_others() {
        assert_eq!(AgentId::parse("claude").unwrap(), AgentId::Claude);
        assert!(AgentId::parse("cursor").is_err());
        assert!(AgentId::parse("").is_err());
    }

    #[test]
    fn every_registered_id_round_trips() {
        for id in AgentId::ALL {
            assert_eq!(AgentId::parse(id.as_str()).unwrap(), *id);
        }
    }

    #[test]
    fn claude_argv_matches_the_cli() {
        assert!(argv(AgentId::Claude, &Launch::New).is_empty());
        assert_eq!(
            argv(AgentId::Claude, &Launch::Resume("abc".into())),
            vec!["--resume".to_string(), "abc".to_string()]
        );
    }
}
