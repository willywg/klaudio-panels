//! `klaudio-statusline-bridge` — the process Claude Code actually invokes
//! every UI tick for tabs Klaudio launches, in place of (but wrapping) the
//! user's own real `statusLine` command.
//!
//! Klaudio spawns `claude` with an ephemeral `--settings` overlay whose
//! `statusLine.command` points at this binary. Claude Code deep-merges that
//! overlay onto the user's real `settings.json`, so only `command` changes.
//! Every tick, Claude Code pipes a JSON blob (model/context/rate-limit
//! usage, among other fields) to this process's stdin and displays this
//! process's stdout as the visible statusline.
//!
//! Contract, in order:
//! 1. Discover a `BridgeContext` via `KLAUDIO_CONTEXT_FILE` (see
//!    `klaudio_panels_lib::usage_snapshot::BridgeContext`). If that's
//!    missing or unusable, fail open: drain our own stdin (so Claude Code's
//!    write side never blocks) and exit 0 with empty stdout.
//! 2. If the context names a pre-existing `original_command`, spawn it via
//!    `/bin/sh -c` with piped stdin and inherited stdout/stderr — we never
//!    buffer the child's stdout ourselves, the OS passes it straight
//!    through.
//! 3. Tee our own stdin: forward every byte to the child (best-effort) while
//!    separately capturing up to 64 KiB for our own JSON parsing.
//! 4. Wait for the child and propagate its exit status faithfully (or exit
//!    0 if there was no child).
//! 5. Best-effort parse the captured buffer and atomically write a
//!    `UsageSnapshot` — this step can never affect steps 2-4's outcome.
//! 6. If Claude Code cancels us (SIGTERM/SIGINT, as it does when a new tick
//!    fires before the previous one finished), kill the child so it's never
//!    orphaned, then exit 143.
//!
//! See the sprint task description / `usage_snapshot.rs` doc comments for
//! the full rationale; this file only implements the mechanism.

use klaudio_panels_lib::usage_snapshot::{
    BridgeContext, ContextUsage, ModelInfo, RateLimitWindows, RateWindow, UsageSnapshot,
};
use serde_json::Value;
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Cap on how much of `KLAUDIO_CONTEXT_FILE`'s contents we ever read.
const CONTEXT_FILE_READ_CAP: u64 = 8 * 1024;
/// Cap on how much of our own stdin we accumulate for JSON parsing. Every
/// byte past this is still forwarded to the child, just not captured.
const STDIN_PARSE_CAP: usize = 64 * 1024;
/// Cap on the serialized snapshot we're willing to write.
const SNAPSHOT_SIZE_CAP: usize = 4 * 1024;
/// Chunk size for the stdin tee loop.
const STDIN_CHUNK_SIZE: usize = 8 * 1024;
/// Poll interval while waiting for the child, so the signal-handling thread
/// never has to fight us for a long-held lock.
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(20);

fn main() {
    let context = match load_context() {
        Some(context) => context,
        None => {
            // No usable context: this is optional telemetry, never an
            // error worth surfacing. Drain our own stdin so Claude Code's
            // write side never blocks on us, then exit clean and silent.
            drain_stdin_to_eof();
            std::process::exit(0);
        }
    };

    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    spawn_signal_handler(Arc::clone(&child_slot));

    let (child, child_stdin) = spawn_original_command(context.original_command.as_deref());
    // Populate the shared slot immediately after spawning and before the
    // (potentially long-running) stdin tee loop starts, so a cancellation
    // signal can never arrive while the child is unaccounted for.
    *child_slot.lock().unwrap() = child;

    let stdin_buf = tee_stdin(child_stdin);

    let exit_code = wait_for_child(&child_slot);

    // Best-effort only: must never change our own exit code or stdout.
    write_snapshot_best_effort(&context, &stdin_buf);

    std::process::exit(exit_code);
}

/// Reads `KLAUDIO_CONTEXT_FILE` (capped at `CONTEXT_FILE_READ_CAP` bytes)
/// and parses it as a `BridgeContext`. Any failure along the way — the env
/// var unset, the file unopenable, or the (possibly truncated) contents not
/// parsing as a `BridgeContext` JSON object — collapses to `None`; the
/// caller treats all of these identically as "no usable context".
fn load_context() -> Option<BridgeContext> {
    let path = env::var("KLAUDIO_CONTEXT_FILE").ok()?;
    let file = fs::File::open(&path).ok()?;
    let mut buf = Vec::new();
    file.take(CONTEXT_FILE_READ_CAP)
        .read_to_end(&mut buf)
        .ok()?;
    serde_json::from_slice(&buf).ok()
}

/// Drains our own stdin to EOF and discards it — a courtesy so Claude
/// Code, which is writing to our stdin, never blocks/SIGPIPEs because
/// nobody drained the pipe on our end.
fn drain_stdin_to_eof() {
    let mut sink = io::sink();
    let _ = io::copy(&mut io::stdin(), &mut sink);
}

/// Spawns `original_command` (if any, and non-empty) via `/bin/sh -c`,
/// exactly as Claude Code itself invokes statusLine commands: one opaque
/// argv element, piped stdin, inherited stdout/stderr, and with
/// `KLAUDIO_CONTEXT_FILE` scrubbed from its environment. Returns `(None,
/// None)` if there's nothing to chain to or spawning failed for any
/// reason — the caller proceeds regardless, it just won't have a child to
/// wait on or forward stdin to.
fn spawn_original_command(original_command: Option<&str>) -> (Option<Child>, Option<ChildStdin>) {
    let command = match original_command {
        Some(cmd) if !cmd.is_empty() => cmd,
        _ => return (None, None),
    };

    let spawned = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .env_remove("KLAUDIO_CONTEXT_FILE")
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();

    match spawned {
        Ok(mut child) => {
            let stdin = child.stdin.take();
            (Some(child), stdin)
        }
        Err(_) => (None, None),
    }
}

/// Reads our own stdin to EOF in chunks, forwarding every chunk to the
/// child's stdin (best-effort — a write failure just stops further
/// forwarding, it never stops us draining our own stdin) while separately
/// accumulating up to `STDIN_PARSE_CAP` bytes for later JSON parsing.
/// Dropping `child_stdin` at the end of this function signals EOF to the
/// child too.
fn tee_stdin(mut child_stdin: Option<ChildStdin>) -> Vec<u8> {
    let mut captured = Vec::with_capacity(STDIN_PARSE_CAP.min(8192));
    let mut chunk = [0u8; STDIN_CHUNK_SIZE];
    let mut stdin = io::stdin();

    loop {
        let n = match stdin.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };

        if let Some(cs) = child_stdin.as_mut() {
            if cs.write_all(&chunk[..n]).is_err() {
                // Child stopped reading (closed/exited) — stop forwarding
                // silently, but keep draining our own stdin below.
                child_stdin = None;
            }
        }

        if captured.len() < STDIN_PARSE_CAP {
            let room = STDIN_PARSE_CAP - captured.len();
            let take = room.min(n);
            captured.extend_from_slice(&chunk[..take]);
        }
    }

    captured
}

/// Registers SIGTERM/SIGINT handling on a background thread. Claude Code
/// cancels an in-flight statusLine invocation by signaling it when a new
/// tick fires before the previous one finished; we must never let that
/// orphan the child. Best-effort: if signal registration itself fails, we
/// simply won't have special cancellation handling (the child would still
/// get cleaned up normally via process-group semantics in the common case).
fn spawn_signal_handler(child_slot: Arc<Mutex<Option<Child>>>) {
    let mut signals = match Signals::new([SIGTERM, SIGINT]) {
        Ok(signals) => signals,
        Err(_) => return,
    };

    std::thread::spawn(move || {
        // Block until the first SIGTERM/SIGINT arrives.
        if signals.forever().next().is_some() {
            if let Ok(mut guard) = child_slot.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
            // Conventional "killed by signal 15" exit code. We don't need
            // to re-raise the literal signal on ourselves.
            std::process::exit(143);
        }
    });
}

/// Polls the shared child slot until it exits (or was never populated),
/// translating its `ExitStatus` into our own exit code. Locks the mutex
/// only briefly per iteration so the signal-handling thread is never stuck
/// waiting behind a long-held lock.
fn wait_for_child(child_slot: &Arc<Mutex<Option<Child>>>) -> i32 {
    loop {
        {
            let mut guard = child_slot.lock().unwrap();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        return exit_code_from_status(status);
                    }
                    Ok(None) => {
                        // Still running; drop the lock and poll again.
                    }
                    Err(_) => {
                        *guard = None;
                        return 0;
                    }
                },
                None => return 0,
            }
        }
        std::thread::sleep(WAIT_POLL_INTERVAL);
    }
}

/// `ExitStatus::code()` when the child exited normally; `128 + signal`
/// (the conventional Unix "killed by signal N" encoding) when it was
/// terminated by a signal; `1` in the (practically unreachable) case
/// neither is available.
fn exit_code_from_status(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        code
    } else if let Some(signal) = status.signal() {
        128 + signal
    } else {
        1
    }
}

/// Best-effort snapshot write. Any failure here — bad JSON, a missing
/// field, an oversized serialized snapshot, a filesystem error — is
/// silently swallowed (stderr logging only); this must never affect our
/// own exit code or stdout.
fn write_snapshot_best_effort(context: &BridgeContext, stdin_buf: &[u8]) {
    let observed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let Some(snapshot) = build_snapshot(stdin_buf, &context.tab_id, observed_at) else {
        return;
    };

    let json = match serde_json::to_vec(&snapshot) {
        Ok(json) => json,
        Err(e) => {
            eprintln!("klaudio-statusline-bridge: failed to serialize snapshot: {e}");
            return;
        }
    };

    if json.len() > SNAPSHOT_SIZE_CAP {
        eprintln!(
            "klaudio-statusline-bridge: snapshot is {} bytes, exceeds {SNAPSHOT_SIZE_CAP}-byte cap; skipping write",
            json.len()
        );
        return;
    }

    if let Err(e) = write_snapshot_atomically(&context.snapshot_dir, &context.tab_id, &json) {
        eprintln!("klaudio-statusline-bridge: failed to write snapshot: {e}");
    }
}

/// Writes `json` to a sibling temp file inside `dir` and renames it onto
/// `<dir>/<tab_id>.json`. Same-filesystem rename is atomic on POSIX, which
/// is why the temp file must live alongside the final path rather than in
/// a system temp directory.
fn write_snapshot_atomically(dir: &str, tab_id: &str, json: &[u8]) -> io::Result<()> {
    fs::create_dir_all(dir)?;

    let tmp_name = format!(".{tab_id}.json.tmp-{}", std::process::id());
    let tmp_path = Path::new(dir).join(tmp_name);
    let final_path = Path::new(dir).join(format!("{tab_id}.json"));

    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, &final_path)?;
    Ok(())
}

/// Pure whitelist extraction: parses `buf` as JSON and pulls out only the
/// fields Klaudio's status bar cares about, treating every field as
/// independently optional. Returns `None` only when `buf` doesn't parse as
/// a JSON object at all (empty input, malformed JSON, or a valid JSON
/// value that isn't an object) — there is nothing to build a snapshot
/// from in that case. Otherwise always returns `Some`, even if every
/// individual field inside came back absent.
fn build_snapshot(buf: &[u8], tab_id: &str, observed_at: u64) -> Option<UsageSnapshot> {
    let value: Value = serde_json::from_slice(buf).ok()?;
    if !value.is_object() {
        return None;
    }

    Some(UsageSnapshot {
        provider_id: "claude".to_string(),
        tab_id: tab_id.to_string(),
        session_id: extract_session_id(&value),
        observed_at,
        model: extract_model(&value),
        context: extract_context(&value),
        rate_limits: extract_rate_limits(&value),
    })
}

fn extract_session_id(value: &Value) -> Option<String> {
    value.get("session_id")?.as_str().map(str::to_string)
}

/// `model.id` + `model.display_name` are both required to build a
/// `ModelInfo` (the struct has no `Option` fields) — if `model` is absent,
/// isn't an object, or is missing/wrong-typed on either sub-field, the
/// whole thing is treated as absent.
fn extract_model(value: &Value) -> Option<ModelInfo> {
    let model = value.get("model")?.as_object()?;
    let id = model.get("id")?.as_str()?.to_string();
    let display_name = model.get("display_name")?.as_str()?.to_string();
    Some(ModelInfo { id, display_name })
}

/// `context_window`'s two sub-fields are each independently optional
/// (`ContextUsage`'s fields are both `Option<f32>`) — but `context_window`
/// itself must be present and an object for a `ContextUsage` to be built
/// at all; otherwise there's nothing to extract from.
fn extract_context(value: &Value) -> Option<ContextUsage> {
    let context_window = value.get("context_window")?;
    if !context_window.is_object() {
        return None;
    }
    Some(ContextUsage {
        used_percentage: context_window
            .get("used_percentage")
            .and_then(Value::as_f64)
            .map(|v| v as f32),
        remaining_percentage: context_window
            .get("remaining_percentage")
            .and_then(Value::as_f64)
            .map(|v| v as f32),
    })
}

/// A `RateWindow`'s two fields are both required (neither is `Option`), so
/// a window is only built when both `used_percentage` and `resets_at` are
/// present with the right type; otherwise that window is `None`.
fn extract_rate_window(value: &Value) -> Option<RateWindow> {
    let used_percentage = value.get("used_percentage")?.as_f64()? as f32;
    let resets_at = value.get("resets_at")?.as_u64()?;
    Some(RateWindow {
        used_percentage,
        resets_at,
    })
}

/// `rate_limits` itself must be present and an object to build
/// `RateLimitWindows` at all; each of `five_hour`/`seven_day` is then
/// independently optional within it.
fn extract_rate_limits(value: &Value) -> Option<RateLimitWindows> {
    let rate_limits = value.get("rate_limits")?;
    if !rate_limits.is_object() {
        return None;
    }
    Some(RateLimitWindows {
        five_hour: rate_limits.get("five_hour").and_then(extract_rate_window),
        seven_day: rate_limits.get("seven_day").and_then(extract_rate_window),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_full_payload_extracts_everything() {
        let payload = br#"{
            "model": {"id": "claude-opus-5", "display_name": "Opus"},
            "context_window": {"used_percentage": 45.2, "remaining_percentage": 54.8},
            "rate_limits": {
                "five_hour": {"used_percentage": 12.0, "resets_at": 1700000000},
                "seven_day": {"used_percentage": 3.5, "resets_at": 1700600000}
            },
            "session_id": "sess-abc"
        }"#;

        let snap = build_snapshot(payload, "tab-1", 42).expect("should parse");
        assert_eq!(snap.provider_id, "claude");
        assert_eq!(snap.tab_id, "tab-1");
        assert_eq!(snap.observed_at, 42);
        assert_eq!(snap.session_id.as_deref(), Some("sess-abc"));

        let model = snap.model.expect("model present");
        assert_eq!(model.id, "claude-opus-5");
        assert_eq!(model.display_name, "Opus");

        let context = snap.context.expect("context present");
        assert_eq!(context.used_percentage, Some(45.2));
        assert_eq!(context.remaining_percentage, Some(54.8));

        let rate_limits = snap.rate_limits.expect("rate limits present");
        let five_hour = rate_limits.five_hour.expect("five_hour present");
        assert_eq!(five_hour.used_percentage, 12.0);
        assert_eq!(five_hour.resets_at, 1700000000);
        let seven_day = rate_limits.seven_day.expect("seven_day present");
        assert_eq!(seven_day.used_percentage, 3.5);
        assert_eq!(seven_day.resets_at, 1700600000);
    }

    #[test]
    fn missing_rate_limits_entirely_yields_none() {
        let payload = br#"{
            "model": {"id": "claude-opus-5", "display_name": "Opus"},
            "context_window": {"used_percentage": 10.0, "remaining_percentage": 90.0}
        }"#;

        let snap = build_snapshot(payload, "tab-2", 1).expect("should parse");
        assert!(snap.rate_limits.is_none());
        assert!(snap.model.is_some());
        assert!(snap.context.is_some());
        assert!(snap.session_id.is_none());
    }

    #[test]
    fn null_context_fields_are_independently_absent() {
        let payload = br#"{
            "context_window": {"used_percentage": null, "remaining_percentage": null}
        }"#;

        let snap = build_snapshot(payload, "tab-3", 2).expect("should parse");
        let context = snap.context.expect("context_window key present => Some");
        assert_eq!(context.used_percentage, None);
        assert_eq!(context.remaining_percentage, None);
        assert!(snap.model.is_none());
        assert!(snap.rate_limits.is_none());
    }

    #[test]
    fn malformed_or_non_object_json_yields_none() {
        assert!(build_snapshot(b"{not json", "tab-4", 3).is_none());
        assert!(build_snapshot(b"\"just a string\"", "tab-4", 3).is_none());
        assert!(build_snapshot(b"[1, 2, 3]", "tab-4", 3).is_none());
        assert!(build_snapshot(b"42", "tab-4", 3).is_none());
    }

    #[test]
    fn empty_input_yields_none() {
        assert!(build_snapshot(b"", "tab-5", 4).is_none());
    }

    #[test]
    fn wrong_typed_model_subfield_makes_whole_model_absent() {
        let payload = br#"{"model": {"id": 123, "display_name": "Opus"}}"#;
        let snap = build_snapshot(payload, "tab-6", 5).expect("should parse");
        assert!(snap.model.is_none());
    }

    #[test]
    fn rate_window_requires_both_fields() {
        let payload = br#"{"rate_limits": {"five_hour": {"used_percentage": 10.0}}}"#;
        let snap = build_snapshot(payload, "tab-7", 6).expect("should parse");
        let rate_limits = snap.rate_limits.expect("rate_limits key present => Some");
        assert!(rate_limits.five_hour.is_none());
        assert!(rate_limits.seven_day.is_none());
    }

    #[test]
    fn exit_code_from_normal_exit_uses_code() {
        // Sanity check on the pure translation helper via a real child.
        let status = Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 7")
            .status()
            .expect("spawn /bin/sh");
        assert_eq!(exit_code_from_status(status), 7);
    }
}
