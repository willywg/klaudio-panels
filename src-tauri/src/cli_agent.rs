//! Observe-only OSC 777 sniffer for warp's CLI-agent protocol.
//!
//! Frame: `\x1b]777;notify;<TITLE>;<BODY>(\x07|\x1b\\)`
//! Sentinel `<TITLE>`: `warp://cli-agent`
//! `<BODY>`: plain JSON, schema documented in
//! <https://github.com/warpdotdev/warp/blob/main/app/src/terminal/cli_agent_sessions/event/v1.rs>.
//!
//! The sniffer does not mutate the byte stream — bytes are still
//! forwarded to xterm.js verbatim. This is the carve-out to CLAUDE.md
//! non-negotiable #2: a stable sidechannel from a plugin we don't
//! control but whose wire format is open and versioned.

use serde::{Deserialize, Serialize};

const PREFIX: &[u8] = b"\x1b]777;notify;";
const SENTINEL: &str = "warp://cli-agent";
const MAX_BODY: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct CliAgentEvent {
    pub v: u32,
    pub agent: String,
    pub event: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub query: Option<String>,
    pub response: Option<String>,
    pub transcript_path: Option<String>,
    pub summary: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input_preview: Option<String>,
    pub plugin_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawEvent {
    v: Option<u32>,
    agent: Option<String>,
    event: String,
    session_id: Option<String>,
    cwd: Option<String>,
    project: Option<String>,
    query: Option<String>,
    response: Option<String>,
    transcript_path: Option<String>,
    summary: Option<String>,
    tool_name: Option<String>,
    tool_input: Option<serde_json::Value>,
    plugin_version: Option<String>,
}

#[derive(Debug)]
enum SnifferState {
    Normal,
    Matching { matched: usize },
    Capturing,
    EscInBody,
}

pub struct Osc777Sniffer {
    state: SnifferState,
    body: Vec<u8>,
}

impl Default for Osc777Sniffer {
    fn default() -> Self {
        Self::new()
    }
}

impl Osc777Sniffer {
    pub fn new() -> Self {
        Self {
            state: SnifferState::Normal,
            body: Vec::with_capacity(512),
        }
    }

    /// Feed a chunk of PTY bytes; returns events that completed inside
    /// this chunk. The chunk itself is not consumed — the caller still
    /// forwards it to xterm.js.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<CliAgentEvent> {
        let mut out = Vec::new();
        for &b in chunk {
            match self.state {
                SnifferState::Normal => {
                    if b == PREFIX[0] {
                        self.state = SnifferState::Matching { matched: 1 };
                    }
                }
                SnifferState::Matching { matched } => {
                    if b == PREFIX[matched] {
                        let next = matched + 1;
                        if next == PREFIX.len() {
                            self.body.clear();
                            self.state = SnifferState::Capturing;
                        } else {
                            self.state = SnifferState::Matching { matched: next };
                        }
                    } else if b == PREFIX[0] {
                        // a fresh restart: the failing byte is itself a prefix start.
                        self.state = SnifferState::Matching { matched: 1 };
                    } else {
                        self.state = SnifferState::Normal;
                    }
                }
                SnifferState::Capturing => match b {
                    0x07 => {
                        if let Some(ev) = self.finalize() {
                            out.push(ev);
                        }
                        self.reset();
                    }
                    0x1b => {
                        self.state = SnifferState::EscInBody;
                    }
                    _ => {
                        if self.body.len() >= MAX_BODY {
                            // malformed: terminator never arrived. drop and resync.
                            self.reset();
                        } else {
                            self.body.push(b);
                        }
                    }
                },
                SnifferState::EscInBody => {
                    if b == b'\\' {
                        // ST terminator (ESC + backslash)
                        if let Some(ev) = self.finalize() {
                            out.push(ev);
                        }
                        self.reset();
                    } else {
                        // stray ESC inside body — treat as malformed, resync.
                        self.reset();
                        // the byte we just saw might be the start of a new
                        // prefix; re-process it through Normal.
                        if b == PREFIX[0] {
                            self.state = SnifferState::Matching { matched: 1 };
                        }
                    }
                }
            }
        }
        out
    }

    fn reset(&mut self) {
        self.state = SnifferState::Normal;
        self.body.clear();
    }

    /// Consume `self.body` (already collected between OSC start and
    /// terminator) and return the parsed event if it carries our
    /// sentinel and is not a `stop` (JSONL is canonical for `stop`).
    fn finalize(&mut self) -> Option<CliAgentEvent> {
        let body = std::mem::take(&mut self.body);
        let raw = std::str::from_utf8(&body).ok()?;
        let (title, json_body) = raw.split_once(';')?;
        if title != SENTINEL {
            return None;
        }
        let parsed: RawEvent = serde_json::from_str(json_body).ok()?;

        // JSONL watcher is the canonical source for turn-completion;
        // dropping `stop` here keeps the frontend from having to dedup.
        if parsed.event == "stop" {
            return None;
        }

        let tool_input_preview = parsed.tool_input.as_ref().and_then(|val| {
            val.get("command")
                .or_else(|| val.get("file_path"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

        Some(CliAgentEvent {
            v: parsed.v.unwrap_or(1),
            agent: parsed.agent.unwrap_or_default(),
            event: parsed.event,
            session_id: parsed.session_id,
            cwd: parsed.cwd,
            project: parsed.project,
            query: parsed.query,
            response: parsed.response,
            transcript_path: parsed.transcript_path,
            summary: parsed.summary,
            tool_name: parsed.tool_name,
            tool_input_preview,
            plugin_version: parsed.plugin_version,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_bel(json: &str) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"\x1b]777;notify;");
        out.extend_from_slice(SENTINEL.as_bytes());
        out.push(b';');
        out.extend_from_slice(json.as_bytes());
        out.push(0x07);
        out
    }

    fn frame_st(json: &str) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"\x1b]777;notify;");
        out.extend_from_slice(SENTINEL.as_bytes());
        out.push(b';');
        out.extend_from_slice(json.as_bytes());
        out.extend_from_slice(b"\x1b\\");
        out
    }

    #[test]
    fn parses_permission_request_bel() {
        let json = r#"{"v":1,"agent":"claude","event":"permission_request","session_id":"abc","cwd":"/p","project":"/p","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/foo"}}"#;
        let mut s = Osc777Sniffer::new();
        let events = s.feed(&frame_bel(json));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.event, "permission_request");
        assert_eq!(e.agent, "claude");
        assert_eq!(e.tool_name.as_deref(), Some("Bash"));
        assert_eq!(e.tool_input_preview.as_deref(), Some("rm -rf /tmp/foo"));
    }

    #[test]
    fn parses_idle_prompt_st_terminator() {
        let json = r#"{"v":1,"agent":"claude","event":"idle_prompt","query":"are you there?"}"#;
        let mut s = Osc777Sniffer::new();
        let events = s.feed(&frame_st(json));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "idle_prompt");
        assert_eq!(events[0].query.as_deref(), Some("are you there?"));
    }

    #[test]
    fn split_prefix_byte_by_byte() {
        let json = r#"{"v":1,"agent":"claude","event":"permission_request","tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}"#;
        let bytes = frame_bel(json);
        let mut s = Osc777Sniffer::new();
        let mut events = Vec::new();
        for b in &bytes {
            events.extend(s.feed(&[*b]));
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_input_preview.as_deref(), Some("/tmp/x"));
    }

    #[test]
    fn split_chunks_in_middle_of_body() {
        let json = r#"{"v":1,"agent":"claude","event":"permission_request"}"#;
        let bytes = frame_bel(json);
        let mut s = Osc777Sniffer::new();
        // split somewhere inside the JSON body
        let mid = bytes.len() / 2;
        let a = s.feed(&bytes[..mid]);
        let b = s.feed(&bytes[mid..]);
        assert!(a.is_empty());
        assert_eq!(b.len(), 1);
    }

    #[test]
    fn drops_stop_event() {
        let json = r#"{"v":1,"agent":"claude","event":"stop","summary":"done"}"#;
        let mut s = Osc777Sniffer::new();
        let events = s.feed(&frame_bel(json));
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn ignores_wrong_sentinel() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x1b]777;notify;klaudio-panels;");
        bytes.extend_from_slice(b"{\"event\":\"permission_request\"}");
        bytes.push(0x07);
        let mut s = Osc777Sniffer::new();
        assert!(s.feed(&bytes).is_empty());
    }

    #[test]
    fn ignores_other_osc_777_subcommand() {
        // Generic OSC 777 (used by xterm/KDE for desktop notifications)
        let bytes = b"\x1b]777;other;Title;Body\x07";
        let mut s = Osc777Sniffer::new();
        assert!(s.feed(bytes).is_empty());
    }

    #[test]
    fn malformed_json_drops_silently() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x1b]777;notify;");
        bytes.extend_from_slice(SENTINEL.as_bytes());
        bytes.extend_from_slice(b";not json{{{");
        bytes.push(0x07);
        let mut s = Osc777Sniffer::new();
        assert!(s.feed(&bytes).is_empty());
        // sniffer recovers and parses a subsequent valid frame
        let json = r#"{"v":1,"agent":"claude","event":"idle_prompt"}"#;
        let events = s.feed(&frame_bel(json));
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn oversized_body_resets() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x1b]777;notify;");
        bytes.extend_from_slice(SENTINEL.as_bytes());
        bytes.push(b';');
        // body without terminator, > MAX_BODY
        bytes.extend(std::iter::repeat_n(b'x', MAX_BODY + 1024));
        let mut s = Osc777Sniffer::new();
        let events = s.feed(&bytes);
        assert!(events.is_empty());
        // sniffer is back to Normal and can parse a fresh frame
        let json = r#"{"v":1,"agent":"claude","event":"idle_prompt"}"#;
        let after = s.feed(&frame_bel(json));
        assert_eq!(after.len(), 1);
    }

    #[test]
    fn passes_through_non_osc_bytes() {
        // Sniffer is observe-only; verify it doesn't panic on
        // arbitrary terminal output.
        let noise: &[u8] = b"hello \x1b[31mred\x1b[0m world \x07 done";
        let mut s = Osc777Sniffer::new();
        assert!(s.feed(noise).is_empty());
    }

    #[test]
    fn restart_after_failed_match() {
        // A near-miss prefix followed immediately by a real one.
        // ESC ] 7 7 7 ; X — fails at X — then a real frame starts.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x1b]777;X");
        bytes.extend_from_slice(&frame_bel(
            r#"{"v":1,"agent":"claude","event":"idle_prompt"}"#,
        ));
        let mut s = Osc777Sniffer::new();
        let events = s.feed(&bytes);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn tool_input_command_preferred_over_file_path() {
        let json = r#"{"v":1,"agent":"claude","event":"permission_request","tool_name":"Edit","tool_input":{"command":"echo hi","file_path":"/tmp/x"}}"#;
        let mut s = Osc777Sniffer::new();
        let events = s.feed(&frame_bel(json));
        assert_eq!(events[0].tool_input_preview.as_deref(), Some("echo hi"));
    }

    #[test]
    fn version_2_still_parses_via_v1_compatible_fields() {
        // We don't dispatch on version in our slim parser — if a future
        // schema bump changes the shape, serde will fail and the event
        // is dropped. Document by demonstrating: a v2 with same fields
        // still parses today.
        let json = r#"{"v":2,"agent":"claude","event":"idle_prompt"}"#;
        let mut s = Osc777Sniffer::new();
        let events = s.feed(&frame_bel(json));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].v, 2);
    }
}
