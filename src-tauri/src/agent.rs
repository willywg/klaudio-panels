//! The agent registry — the one place that knows an agent exists.
//!
//! Adding an agent means adding a variant to [`AgentId`] and answering, in
//! the `match` arms below, the questions every agent has to answer: where its
//! binary lives, how to tell it apart from a same-named impostor, how it is
//! started, whether it mints a session id before starting, what env it needs
//! and must never inherit, where its sessions are kept, which directory to
//! watch for them, and whether it has a per-project account concept.
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
    Cursor,
}

impl AgentId {
    pub const ALL: &'static [AgentId] = &[AgentId::Claude, AgentId::Cursor];

    pub fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Cursor => "cursor",
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

static CURSOR: AgentSpec = AgentSpec {
    id: AgentId::Cursor,
    display_name: "Cursor",
    bin_name: "cursor-agent",
    not_found: "Cursor CLI not found. Install with `curl https://cursor.com/install -fsS | bash`, \
                or point Klaudio at it explicitly in the agent settings.",
};

pub fn spec(id: AgentId) -> &'static AgentSpec {
    match id {
        AgentId::Claude => &CLAUDE,
        AgentId::Cursor => &CURSOR,
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
        // Cursor's installer symlinks this into its versioned install dir.
        AgentId::Cursor => vec![home.join(".local/bin/cursor-agent")],
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
        // The installer writes a second name for the same binary, `agent` —
        // the one Cursor's docs now teach, and generic enough that another
        // CLI can own it. Only ever a fallback, and only accepted once its
        // `--version` answers like Cursor (see `accepts_version`). Never
        // `cursor`: that is a shim that finds and launches the Cursor IDE.
        AgentId::Cursor => dirs::home_dir()
            .map(|h| vec![h.join(".local/bin/agent")])
            .unwrap_or_default(),
    }
}

/// Whether a candidate's `--version` output identifies it as this agent.
/// Discovery validates candidates by running them, and "it ran" is not "it
/// is ours": a binary named `agent` can belong to anything, and the path a
/// user pastes into the settings can be the Cursor IDE's `cursor`.
pub fn accepts_version(id: AgentId, stdout: &str) -> bool {
    match id {
        // Every `claude` we have ever found this way was Claude Code; the
        // name is specific enough that the probe succeeding is the check.
        AgentId::Claude => true,
        // `cursor-agent --version` prints its release as `YYYY.MM.DD-<sha>`
        // (`2026.09.18-9a7762b`). The IDE prints a semver, and an unrelated
        // `agent` prints whatever it prints.
        AgentId::Cursor => stdout
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .is_some_and(is_cursor_release),
    }
}

fn is_cursor_release(line: &str) -> bool {
    let Some((date, sha)) = line.split_once('-') else {
        return false;
    };
    let parts: Vec<&str> = date.split('.').collect();
    parts.len() == 3
        && [4, 2, 2]
            .iter()
            .zip(&parts)
            .all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_digit()))
        && !sha.is_empty()
        && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether this agent can be handed a session id it has not seen yet, minted
/// before the process starts — in which case a new tab is born knowing its
/// session and never goes through the watcher's FIFO correlation.
///
/// Claude cannot: it chooses its own id and says so only by writing a
/// transcript. Cursor can, and must — `cursor-agent create-chat` returns an id
/// without writing anything to disk, and a chat directory only appears once
/// the agent opens it, so there is nothing to correlate a bare
/// `cursor-agent` against until it is too late to be useful.
pub fn mints_session_ids(id: AgentId) -> bool {
    match id {
        AgentId::Claude => false,
        AgentId::Cursor => true,
    }
}

/// The argv that mints a session id up front, for agents where
/// [`mints_session_ids`] is true. Run with the project as cwd; the id is the
/// last non-empty line of stdout.
pub fn create_session_argv(id: AgentId) -> Option<Vec<String>> {
    match id {
        AgentId::Claude => None,
        AgentId::Cursor => Some(vec!["create-chat".to_string()]),
    }
}

pub fn argv(id: AgentId, launch: &Launch) -> Vec<String> {
    match (id, launch) {
        (AgentId::Claude, Launch::New) => Vec::new(),
        (AgentId::Claude, Launch::Resume(session_id)) => {
            vec!["--resume".to_string(), session_id.clone()]
        }
        // Unreachable from the UI — a new Cursor tab resumes an id minted by
        // `create-chat` (see `mints_session_ids`) — but valid: it starts a
        // chat Klaudio simply never learns the id of.
        (AgentId::Cursor, Launch::New) => Vec::new(),
        // Resuming an id `create-chat` just minted opens it as an empty chat;
        // measured, not assumed (PRP 024).
        (AgentId::Cursor, Launch::Resume(session_id)) => {
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
        // Nothing to unlock. `CURSOR_CONVERSATION_ID` would *work* here — the
        // CLI reads it as a fallback conversation id — but it is undocumented
        // and `--resume <id>` is the documented route to the same place.
        AgentId::Cursor => Vec::new(),
    }
}

/// Env an agent must **not** inherit — the mirror of [`extra_env`], and the
/// reason it belongs in the registry rather than in one global blocklist:
/// every name here describes *one agent's own* session bookkeeping, so each
/// agent declares the markers that would confuse a fresh copy of itself.
///
/// Klaudio hands each child the hydrated login-shell env, and that env comes
/// from `$SHELL -l -c 'env -0'` run as a subprocess of Klaudio — so whatever
/// Klaudio itself was launched with comes back out of the probe and is
/// handed to the agent (#104). `project_env.rs` calls `env_clear()` first,
/// but the hydration that follows puts the ambient env back, so the clear
/// alone does not deliver what its comment promises.
///
/// For Claude that is not cosmetic. A `claude` that sees
/// `CLAUDE_CODE_CHILD_SESSION` **silently stops writing its transcript**, and
/// the transcript is the only thing Klaudio watches: no JSONL means no
/// `session:new`, so the tab is never correlated, never labelled, never
/// listed, and cannot be resumed — the work exists only in the scrollback.
/// The rest of the set describes the session that *launched* Klaudio, not
/// the one it is spawning.
///
/// Names, never a `CLAUDE_CODE_*` wildcard. `CLAUDE_CONFIG_DIR` is load
/// bearing — a prefix match would strip it and move a project off its own
/// profile (decision #13) — and a user may legitimately export others. The
/// cost of naming them is that a marker Claude Code adds later won't be
/// covered until it is listed here; that is the trade, and it fails in the
/// direction we can see rather than the one we can't.
fn blocked_env(id: AgentId) -> &'static [&'static str] {
    match id {
        AgentId::Claude => &[
            "CLAUDECODE",
            "CLAUDE_CODE_BRIDGE_SESSION_ID",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_EXECPATH",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_CODE_SESSION_ATTENDED",
            "CLAUDE_CODE_SESSION_ID",
        ],
        // Measured, not read off the bundle (PRP 024): what a shell command
        // run by `cursor-agent` sees that its parent did not. The shell tool
        // builds that env as `process.env` plus these, so a Klaudio started
        // from inside a Cursor session carries them into every child — and
        // `CURSOR_CONVERSATION_ID` is read back as the conversation to attach
        // to when none is passed, while the sandbox's restore blob is
        // re-applied wherever it is found.
        //
        // Left alone on purpose: `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` (a
        // user may export them; stripping them breaks auth for everyone to
        // protect no one), and `CURSOR_CONFIG_DIR` / `CURSOR_DATA_DIR`, load
        // bearing exactly as `CLAUDE_CONFIG_DIR` is. `CURSOR_INVOKED_AS` also
        // reaches the child, but the launcher re-exports it on every start,
        // so an inherited one never survives long enough to matter.
        AgentId::Cursor => &[
            "AGENT_TRANSCRIPTS",
            "CURSOR_AGENT",
            "CURSOR_CONVERSATION_ID",
            "CURSOR_REQUEST_ID",
            "__CURSOR_SANDBOX_ENV_RESTORE",
        ],
    }
}

/// Removes [`blocked_env`]'s names from a child env, returning the ones that
/// were actually present so the caller can log that it happened.
///
/// Runs on the **fully resolved** env — after the login-shell probe, after
/// direnv, after the spawn overrides — rather than on the probe's output, so
/// the guarantee is about what the agent receives: no later stage can put a
/// marker back. The returned names are safe to log; the values are session
/// ids, socket paths and tokens, and are not.
pub fn strip_blocked_env(id: AgentId, env: &mut Vec<(String, String)>) -> Vec<&'static str> {
    let blocked = blocked_env(id);
    let mut stripped = Vec::new();
    for name in blocked {
        if env.iter().any(|(k, _)| k == name) {
            stripped.push(*name);
        }
    }
    env.retain(|(k, _)| !blocked.contains(&k.as_str()));
    stripped
}

/// Whether an agent is offered before the user has said anything about it.
/// Claude is on because every install before agents existed ran Claude and
/// nothing else, and an update must not change what those users see. Every
/// agent added after it is opt-in, from the settings panel: an update should
/// not start offering — with a picker, badges, and a "not found" error for
/// anyone who never installed it — an agent nobody asked for.
pub fn enabled_by_default(id: AgentId) -> bool {
    match id {
        AgentId::Claude => true,
        AgentId::Cursor => false,
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
        // Cursor has the concept, split across two variables where Claude has
        // one: `CURSOR_CONFIG_DIR` is the account, `CURSOR_DATA_DIR` is where
        // its chats live, and either can move without the other. A correct
        // profile id is a function of both, and the watcher would have to
        // follow one while the listing follows the pair. Until that is built,
        // a `.envrc` that sets them reaches the spawned agent (direnv still
        // applies) but not Klaudio's bookkeeping — see PRP 024.
        AgentId::Cursor => false,
    }
}

pub fn list_sessions(id: AgentId, project_path: &str) -> Result<Vec<SessionMeta>, String> {
    match id {
        AgentId::Claude => crate::sessions::list_claude_sessions(project_path),
        AgentId::Cursor => crate::cursor_sessions::list_cursor_sessions(project_path),
    }
}

/// The directory whose changes mean "a session of this agent changed".
/// Claude's moves with `CLAUDE_CONFIG_DIR`, so this is the default root
/// only — the watcher has always been single-root (decision #13's open
/// follow-up) and this PRP does not change that.
pub fn watch_root(id: AgentId) -> Option<PathBuf> {
    match id {
        AgentId::Claude => dirs::home_dir().map(|h| h.join(".claude/projects")),
        AgentId::Cursor => crate::cursor_sessions::chats_root(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_ids_and_rejects_others() {
        assert_eq!(AgentId::parse("claude").unwrap(), AgentId::Claude);
        assert_eq!(AgentId::parse("cursor").unwrap(), AgentId::Cursor);
        assert!(AgentId::parse("agent").is_err());
        assert!(AgentId::parse("").is_err());
    }

    #[test]
    fn every_registered_id_round_trips() {
        for id in AgentId::ALL {
            assert_eq!(AgentId::parse(id.as_str()).unwrap(), *id);
        }
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn names(env: &[(String, String)]) -> Vec<&str> {
        env.iter().map(|(k, _)| k.as_str()).collect()
    }

    // The regression this exists for (#104): a `claude` that inherits this
    // marker stops writing its transcript in silence, and the transcript is
    // the only thing Klaudio watches.
    #[test]
    fn strips_the_marker_that_disables_transcript_saving() {
        let mut e = env(&[("CLAUDE_CODE_CHILD_SESSION", "1"), ("PATH", "/usr/bin")]);
        let stripped = strip_blocked_env(AgentId::Claude, &mut e);

        assert_eq!(stripped, vec!["CLAUDE_CODE_CHILD_SESSION"]);
        assert_eq!(names(&e), vec!["PATH"]);
    }

    // The reason this is a list of names and not a `CLAUDE_CODE_*` wildcard.
    // Stripping the config dir would move a project off its own profile
    // (decision #13) — silently, and only for the spawn.
    #[test]
    fn never_strips_the_load_bearing_config_dir() {
        let mut e = env(&[
            ("CLAUDE_CONFIG_DIR", "/Users/x/.claude-work"),
            ("CLAUDE_CODE_SESSION_ID", "the-launching-session"),
        ]);
        strip_blocked_env(AgentId::Claude, &mut e);

        assert_eq!(names(&e), vec!["CLAUDE_CONFIG_DIR"]);
    }

    #[test]
    fn leaves_an_unaffected_env_untouched_and_in_order() {
        let before = env(&[("PATH", "/usr/bin"), ("HOME", "/Users/x"), ("TERM", "xterm")]);
        let mut e = before.clone();
        let stripped = strip_blocked_env(AgentId::Claude, &mut e);

        assert!(stripped.is_empty());
        assert_eq!(e, before);
    }

    // Only what was actually there gets reported, because the report is what
    // reaches the log — a list of every name we'd strip would read as if the
    // env had been full of them.
    #[test]
    fn reports_only_the_markers_that_were_present() {
        let mut e = env(&[("CLAUDECODE", "1"), ("PATH", "/usr/bin")]);
        assert_eq!(
            strip_blocked_env(AgentId::Claude, &mut e),
            vec!["CLAUDECODE"]
        );
    }

    #[test]
    fn every_agent_declares_a_blocklist_without_wildcards_or_duplicates() {
        for id in AgentId::ALL {
            let blocked = blocked_env(*id);
            for name in blocked {
                assert!(
                    !name.contains('*'),
                    "{name} looks like a pattern; this matches exact names only"
                );
                assert_eq!(
                    blocked.iter().filter(|n| *n == name).count(),
                    1,
                    "{name} is listed twice"
                );
            }
            for load_bearing in [
                "CLAUDE_CONFIG_DIR",
                "CURSOR_CONFIG_DIR",
                "CURSOR_DATA_DIR",
                "CURSOR_API_KEY",
                "CURSOR_AUTH_TOKEN",
            ] {
                assert!(!blocked.contains(&load_bearing), "{load_bearing} must reach the child");
            }
        }
    }

    // The Cursor half of #104: a fresh `cursor-agent` that inherits the
    // launching session's conversation id reads it back as its own.
    #[test]
    fn strips_the_marker_a_fresh_cursor_would_adopt_as_its_chat() {
        let mut e = env(&[
            ("CURSOR_CONVERSATION_ID", "the-launching-chat"),
            ("CURSOR_AGENT", "1"),
            ("CURSOR_CONFIG_DIR", "/Users/x/.cursor-work"),
            ("PATH", "/usr/bin"),
        ]);
        let stripped = strip_blocked_env(AgentId::Cursor, &mut e);

        assert_eq!(stripped, vec!["CURSOR_AGENT", "CURSOR_CONVERSATION_ID"]);
        assert_eq!(names(&e), vec!["CURSOR_CONFIG_DIR", "PATH"]);
    }

    // Blocklists are per agent: Claude's markers mean nothing to Cursor and
    // are left for whatever the user runs inside it.
    #[test]
    fn one_agents_markers_are_not_anothers() {
        let mut e = env(&[("CLAUDE_CODE_SESSION_ID", "x")]);
        assert!(strip_blocked_env(AgentId::Cursor, &mut e).is_empty());
    }

    #[test]
    fn cursor_is_recognised_by_its_release_shaped_version() {
        assert!(accepts_version(AgentId::Cursor, "2026.09.18-9a7762b\n"));
        // The IDE's `cursor --version`: semver, commit, arch.
        assert!(!accepts_version(
            AgentId::Cursor,
            "1.7.28\nadb0f9e3e4f184bba7f3fa6dbfd72ad0ebb8cfd0\narm64\n"
        ));
        // Some other CLI that took the name `agent`.
        assert!(!accepts_version(AgentId::Cursor, "agent 0.4.1\n"));
        assert!(!accepts_version(AgentId::Cursor, ""));
        assert!(accepts_version(AgentId::Claude, "2.1.280 (Claude Code)"));
    }

    #[test]
    fn only_agents_that_mint_ids_have_a_way_to_mint_one() {
        for id in AgentId::ALL {
            assert_eq!(mints_session_ids(*id), create_session_argv(*id).is_some());
        }
    }

    #[test]
    fn cursor_argv_matches_the_cli() {
        assert_eq!(
            argv(AgentId::Cursor, &Launch::Resume("chat".into())),
            vec!["--resume".to_string(), "chat".to_string()]
        );
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
