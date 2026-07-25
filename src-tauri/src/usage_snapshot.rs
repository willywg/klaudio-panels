// Provider-neutral usage-snapshot data model, shared between the main
// Klaudio process (writer of `BridgeContext`, reader of `UsageSnapshot`
// files) and the `klaudio-statusline-bridge` binary (writer of
// `UsageSnapshot` files, reader of `BridgeContext`). Both live in this crate
// (see `src/bin/klaudio-statusline-bridge.rs`), so this module is the single
// source of truth for both shapes — they must never drift independently.
//
// Only fields actually rendered by the v1 status bar are included: model,
// context usage, and the two rate-limit windows. Cost/lines-changed/session
// duration are deliberately out of scope for now (CLAUDE.md decision #15 —
// this is a compact status bar, not a dashboard).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    /// Always "claude" today; reserved for future non-Claude adapters.
    pub provider_id: String,
    /// The Klaudio-generated PTY id for the tab this snapshot belongs to —
    /// known before Claude even starts, so session-scoped fields can be
    /// trusted without waiting on session_id FIFO promotion.
    pub tab_id: String,
    /// Claude's own session id, once known. Carried as a plain field, never
    /// a path component — it is not required to be a UUID.
    pub session_id: Option<String>,
    /// Klaudio-generated wall-clock ms epoch at snapshot-write time.
    pub observed_at: u64,
    pub model: Option<ModelInfo>,
    pub context: Option<ContextUsage>,
    /// Account/profile-level, not session-level — see the reader's merge
    /// policy (max `observed_at` across every tab file under one profile).
    pub rate_limits: Option<RateLimitWindows>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextUsage {
    pub used_percentage: Option<f32>,
    pub remaining_percentage: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitWindows {
    pub five_hour: Option<RateWindow>,
    pub seven_day: Option<RateWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateWindow {
    pub used_percentage: f32,
    /// Unix epoch seconds, as given by Claude's statusLine JSON.
    pub resets_at: u64,
}

/// Per-tab context the bridge reads to know what to do: which provider/tab
/// it's running for, where to write snapshots, and what pre-existing
/// statusLine command (if any) to chain to. Written atomically (0600) by
/// `statusline_context.rs` before Claude is spawned; the child only ever
/// receives a path to this file (`KLAUDIO_CONTEXT_FILE`), never the values
/// directly as env vars.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeContext {
    pub provider_id: String,
    pub tab_id: String,
    /// Directory the bridge should write `<tab_id>.json` into — already the
    /// full per-profile snapshot directory, not just the app-data root.
    pub snapshot_dir: String,
    /// The effective pre-existing statusLine command to chain to and
    /// preserve, or `None` if there was nothing to preserve.
    pub original_command: Option<String>,
}

/// First 128 bits (32 hex chars) of SHA-256(profile_id), used only as a
/// filesystem-safe directory name — never round-tripped back to a
/// `profile_id`. Callers that need to know "which profile does this
/// directory belong to" must already have the `profile_id` on hand (e.g.
/// from `TerminalTab.profileId`) and re-derive the same hash to look it up;
/// nothing reverses this.
pub fn profile_hash(profile_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(profile_id.as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_hash_is_32_hex_chars() {
        let h = profile_hash("default");
        assert_eq!(h.len(), 32);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn profile_hash_is_deterministic() {
        assert_eq!(profile_hash("custom:abc123"), profile_hash("custom:abc123"));
    }

    #[test]
    fn profile_hash_differs_for_distinct_inputs() {
        assert_ne!(profile_hash("default"), profile_hash("custom:abc123"));
    }

    #[test]
    fn usage_snapshot_round_trips_through_json() {
        let snap = UsageSnapshot {
            provider_id: "claude".into(),
            tab_id: "tab-1".into(),
            session_id: Some("sess-1".into()),
            observed_at: 1_700_000_000_000,
            model: Some(ModelInfo {
                id: "claude-opus-5".into(),
                display_name: "Opus".into(),
            }),
            context: Some(ContextUsage {
                used_percentage: Some(42.0),
                remaining_percentage: Some(58.0),
            }),
            rate_limits: Some(RateLimitWindows {
                five_hour: Some(RateWindow {
                    used_percentage: 31.0,
                    resets_at: 1_700_010_000,
                }),
                seven_day: None,
            }),
        };
        let json = serde_json::to_string(&snap).unwrap();
        let back: UsageSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tab_id, "tab-1");
        assert!(back.rate_limits.unwrap().seven_day.is_none());
    }

    #[test]
    fn bridge_context_round_trips_through_json() {
        let ctx = BridgeContext {
            provider_id: "claude".into(),
            tab_id: "tab-1".into(),
            snapshot_dir: "/tmp/whatever".into(),
            original_command: None,
        };
        let json = serde_json::to_string(&ctx).unwrap();
        let back: BridgeContext = serde_json::from_str(&json).unwrap();
        assert_eq!(back.original_command, None);
        assert_eq!(back.snapshot_dir, "/tmp/whatever");
    }
}
