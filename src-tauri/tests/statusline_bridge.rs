//! Integration tests for the `klaudio-statusline-bridge` binary
//! (`src/bin/klaudio-statusline-bridge.rs`). These spawn the real compiled
//! binary as a subprocess (located via `CARGO_BIN_EXE_klaudio-statusline-bridge`,
//! Cargo's standard mechanism for a test to find a sibling binary target)
//! and drive it through stdin/stdout/env exactly as Claude Code would,
//! rather than exercising the pure logic in isolation — that's covered by
//! the `#[cfg(test)]` unit tests inside the binary's own source file.
//!
//! All waits below are bounded (a handful of seconds at most) so a bug in
//! the bridge can never hang the test suite.

use klaudio_panels_lib::usage_snapshot::BridgeContext;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn bridge_bin() -> &'static str {
    env!("CARGO_BIN_EXE_klaudio-statusline-bridge")
}

/// A fresh, empty temp directory for one test, so parallel test runs never
/// collide on the same context/snapshot/marker files.
fn unique_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "klaudio-bridge-test-{label}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("create test temp dir");
    dir
}

/// Writes a `BridgeContext` JSON file into `dir` and returns its path.
fn write_context(dir: &Path, tab_id: &str, original_command: Option<&str>) -> PathBuf {
    let snapshot_dir = dir.join("snapshots");
    let context = BridgeContext {
        provider_id: "claude".to_string(),
        tab_id: tab_id.to_string(),
        snapshot_dir: snapshot_dir.to_string_lossy().to_string(),
        original_command: original_command.map(str::to_string),
    };
    let context_path = dir.join("context.json");
    fs::write(&context_path, serde_json::to_vec(&context).unwrap()).expect("write context file");
    context_path
}

/// Polls `Child::try_wait` instead of blocking forever, so a hung bridge
/// process fails the test instead of hanging the whole suite.
fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Polls `condition` until it's true or `timeout` elapses. Returns whether
/// it became true in time.
fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn original_command_stdout_and_stdin_pass_through_completely() {
    let dir = unique_dir("large-output");
    let context_path = write_context(&dir, "tab-large", Some("cat"));

    // Deterministic, easy-to-verify input well past the 64 KiB parse cap.
    let input: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();

    let mut child = Command::new(bridge_bin())
        .env("KLAUDIO_CONTEXT_FILE", &context_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn bridge");

    let mut stdin = child.stdin.take().unwrap();
    let input_for_writer = input.clone();
    let writer = std::thread::spawn(move || {
        stdin
            .write_all(&input_for_writer)
            .expect("write stdin to bridge");
        // stdin dropped here -> EOF for the bridge (and, via the tee, for cat).
    });

    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .expect("read bridge stdout");
    writer.join().expect("writer thread panicked");

    let status = wait_with_timeout(&mut child, Duration::from_secs(10))
        .expect("bridge should exit promptly");
    assert!(status.success(), "bridge should exit 0 when `cat` does");
    assert_eq!(
        stdout, input,
        "bridge's inherited stdout must reproduce cat's full passthrough of stdin, unmodified"
    );
}

#[test]
fn stdin_over_parse_cap_still_reaches_original_command_intact() {
    let dir = unique_dir("stdin-cap");
    let marker_path = dir.join("byte-count.txt");
    let original_command = format!("wc -c > {}", marker_path.display());
    let context_path = write_context(&dir, "tab-cap", Some(&original_command));

    // Comfortably over the bridge's 64 KiB own-parsing cap.
    let input_len = 200 * 1024;
    let input = vec![b'x'; input_len];

    let mut child = Command::new(bridge_bin())
        .env("KLAUDIO_CONTEXT_FILE", &context_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn bridge");

    let mut stdin = child.stdin.take().unwrap();
    let input_for_writer = input.clone();
    let writer = std::thread::spawn(move || {
        stdin
            .write_all(&input_for_writer)
            .expect("write stdin to bridge");
    });

    // wc's own stdout was redirected to the marker file by the shell, so
    // the bridge's inherited stdout should end up empty — just drain it.
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .expect("read bridge stdout");
    writer.join().expect("writer thread panicked");

    let status = wait_with_timeout(&mut child, Duration::from_secs(10))
        .expect("bridge should exit promptly");
    assert!(status.success());

    let marker =
        fs::read_to_string(&marker_path).expect("wc -c should have written the marker file");
    let counted: usize = marker
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("marker file did not contain a byte count: {marker:?}"));
    assert_eq!(
        counted, input_len,
        "original command must receive the FULL stdin, not just the 64 KiB slice the bridge keeps for its own parsing"
    );
}

#[test]
fn original_command_nonzero_exit_propagates() {
    let dir = unique_dir("exit-code");
    let context_path = write_context(&dir, "tab-exit", Some("exit 7"));

    let mut child = Command::new(bridge_bin())
        .env("KLAUDIO_CONTEXT_FILE", &context_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn bridge");

    // No input to send; close our end immediately so the bridge's own
    // stdin read hits EOF right away.
    drop(child.stdin.take());

    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .expect("read bridge stdout");

    let status = wait_with_timeout(&mut child, Duration::from_secs(10))
        .expect("bridge should exit promptly");
    assert_eq!(
        status.code(),
        Some(7),
        "bridge must propagate the original command's own exit code"
    );
}

#[test]
fn sigterm_to_bridge_kills_child_without_orphaning() {
    let dir = unique_dir("cancel");
    let pid_marker = dir.join("child.pid");
    // `exec sleep 30` replaces the `/bin/sh -c` process in place, so the
    // pid recorded by `echo $$` is guaranteed to still be the long-running
    // process by the time we read it back — no reliance on shells'
    // optional tail-call exec optimization.
    let original_command = format!("echo $$ > {}; exec sleep 30", pid_marker.display());
    let context_path = write_context(&dir, "tab-cancel", Some(&original_command));

    let mut bridge = Command::new(bridge_bin())
        .env("KLAUDIO_CONTEXT_FILE", &context_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn bridge");

    // Deliberately keep the bridge's stdin open — we're testing
    // mid-flight cancellation, not natural stdin-EOF completion. Drain its
    // stdout on a background thread so it can never block on a full pipe.
    let mut bridge_stdout = bridge.stdout.take().unwrap();
    let stdout_drain = std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = bridge_stdout.read_to_end(&mut sink);
    });

    let got_pid = wait_until(Duration::from_secs(5), || pid_marker.is_file());
    assert!(
        got_pid,
        "original command should have written its pid within 5s"
    );
    let child_pid: u32 = fs::read_to_string(&pid_marker)
        .expect("read pid marker")
        .trim()
        .parse()
        .expect("pid marker should contain a plain integer");

    assert!(
        Path::new(&format!("/proc/{child_pid}")).exists(),
        "child should be alive before cancellation"
    );

    // Send SIGTERM to the bridge itself — not the child — mirroring how
    // Claude Code cancels an in-flight statusLine invocation.
    let bridge_pid = bridge.id();
    let kill_status = Command::new("kill")
        .arg("-TERM")
        .arg(bridge_pid.to_string())
        .status()
        .expect("run `kill -TERM` on the bridge");
    assert!(
        kill_status.success(),
        "`kill -TERM <bridge pid>` should succeed"
    );

    let bridge_status = wait_with_timeout(&mut bridge, Duration::from_secs(5))
        .expect("bridge should exit promptly after SIGTERM");
    assert_eq!(
        bridge_status.code(),
        Some(143),
        "bridge should exit 143 (128 + SIGTERM) after handling cancellation"
    );
    stdout_drain.join().expect("stdout-drain thread panicked");

    let child_gone = wait_until(Duration::from_secs(5), || {
        !Path::new(&format!("/proc/{child_pid}")).exists()
    });
    assert!(
        child_gone,
        "child process (pid {child_pid}) must not be left running (orphaned) after the bridge is cancelled"
    );
}
