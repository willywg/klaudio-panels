//! Reads and watches the `UsageSnapshot` files written by the
//! `klaudio-statusline-bridge` helper binary (see `usage_snapshot.rs` and
//! `src/bin/klaudio-statusline-bridge.rs`) under
//! `<app_data_dir>/status-snapshots/<profile_hash>/<tab_id>.json`.
//!
//! Two independent pieces:
//! - A global `notify-debouncer-full` watcher (mirrors `session_watcher.rs`'s
//!   shape closely — same debounce duration, same "park a thread holding the
//!   debouncer" lifetime, same fail-silent philosophy on anything that
//!   doesn't parse) installed once at boot, emitting a flat `usage:snapshot`
//!   Tauri event whenever a file that looks like a real snapshot changes.
//! - `read_status_snapshot`, a pull-based command for a tab to fetch its own
//!   snapshot plus the profile's freshest rate-limit window on demand (e.g.
//!   right after a tab is created, before the bridge has ticked yet).
//!
//! The bridge writes atomically (temp file + `rename()`), so a fully-written
//! file never appears as a torn write — but we still never trust it blindly:
//! a corrupted disk sector or a future bridge bug is still possible, and a
//! debounce tick can in principle race a rename. Both halves of this module
//! treat "doesn't parse as `UsageSnapshot`" as a normal, silent no-op, never
//! an error.
//!
//! **Known limitation:** the very first snapshot ever written for a brand
//! new `<profile_hash>` directory can, in principle, race the recursive
//! watcher's own registration of that new subdirectory (inotify only learns
//! about a newly created directory from the `Create(Folder)` event, and
//! adds a watch for it asynchronously relative to that event — see
//! `notify`'s `inotify.rs::add_watch_by_event`); a write landing in that
//! narrow window can be missed by the live `usage:snapshot` event. This
//! doesn't affect correctness of `read_status_snapshot`, which reads the
//! file directly rather than depending on having observed a live event —
//! callers should pull a tab's status once after creating it rather than
//! relying solely on the push channel for the first tick.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::usage_snapshot::{profile_hash, RateLimitWindows, UsageSnapshot};

const DEBOUNCE_MS: u64 = 200;

/// Subdirectory of `app_data_dir` the bridge writes snapshots under. Shared
/// by the watcher, the read command, and pruning so all three always agree
/// on where the root is.
const STATUS_SNAPSHOTS_DIR_NAME: &str = "status-snapshots";

/// How long a snapshot file is trusted before `prune_stale_snapshots`
/// considers it stale. A tab that's been closed (or a profile that's no
/// longer used) stops getting new writes from the bridge, so without this
/// its last snapshot would sit on disk forever.
const DEFAULT_SNAPSHOT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// This tab's own snapshot, plus the profile-wide freshest rate-limit
/// window — see `read_status_snapshot`.
#[derive(Debug, Clone, Serialize)]
pub struct TabStatusView {
    /// This tab's own snapshot file — model/context/session_id. `None` if
    /// no snapshot has ever been written for this tab yet (perfectly
    /// normal: "no data yet", not an error).
    pub tab: Option<UsageSnapshot>,
    /// Account-level rate limits, merged across every tab's snapshot file
    /// under this profile's directory — NOT scoped to this one tab_id. See
    /// `freshest_rate_limits` for the merge policy.
    pub profile_rate_limits: Option<ProfileRateLimits>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileRateLimits {
    pub rate_limits: RateLimitWindows,
    pub observed_at: u64,
}

// ---------------------------------------------------------------------
// Part A — the watcher
// ---------------------------------------------------------------------

/// True when `path` looks like `<root>/<profile_hash>/<tab_id>.json`: a
/// file exactly two path components below `root`, with a `.json`
/// extension. This is deliberately structural rather than content-based —
/// it filters out directory-create events, unrelated files, and the
/// bridge's own atomic-write temp files (`.{tab_id}.json.tmp-{pid}`, which
/// never end in `.json`) before we bother reading anything off disk.
fn looks_like_snapshot_path(root: &Path, path: &Path) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return false;
    }
    match path.strip_prefix(root) {
        Ok(rel) => rel.components().count() == 2,
        Err(_) => false,
    }
}

/// Reads and parses `path` as a `UsageSnapshot`, but only if it structurally
/// looks like a real snapshot file under `root` (see
/// `looks_like_snapshot_path`). Any failure — wrong shape, unreadable,
/// malformed/partial JSON — collapses to `None` silently; this is expected
/// occasionally (e.g. a debounce tick racing the bridge's rename) and must
/// never surface as an error or a panic.
fn read_valid_snapshot(root: &Path, path: &Path) -> Option<UsageSnapshot> {
    if !looks_like_snapshot_path(root, path) {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<UsageSnapshot>(&bytes).ok()
}

/// Core watcher logic, parameterized over the snapshot root directory and an
/// `on_snapshot` callback rather than a live `tauri::AppHandle` — this is
/// the unit under test (see `tests::watcher`); `install` below is a thin
/// wrapper that resolves the real `<app_data_dir>/status-snapshots/` root
/// and forwards parsed snapshots to `AppHandle::emit`.
///
/// Installs a debouncer, watches `root` recursively, then moves the
/// debouncer into a parked thread so it outlives this call — identical
/// lifetime management to `session_watcher::install`.
fn install_watching_dir<F>(root: PathBuf, on_snapshot: F) -> Result<(), String>
where
    F: Fn(UsageSnapshot) + Send + 'static,
{
    fs::create_dir_all(&root).map_err(|e| format!("failed to create {}: {e}", root.display()))?;

    // Compare canonical paths only. On macOS the platform backend reports
    // event paths already resolved through any symlink in the chain, so a
    // watch root containing one (`/var/folders/...`, which is a symlink to
    // `/private/var/folders/...`, i.e. anything under `std::env::temp_dir()`)
    // makes every `strip_prefix(root)` below fail and silently drops every
    // snapshot. `sessions.rs`'s `canonical()` normalizes for the same reason
    // before comparing a session's `cwd` against a project path.
    //
    // `unwrap_or` keeps the un-canonicalized root rather than failing the
    // install: `create_dir_all` above just succeeded, so a failure here is
    // an exotic race, and a watcher on the literal path is still better than
    // no watcher at all.
    let root = root.canonicalize().unwrap_or(root);

    let watch_root = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                for ev in events {
                    if !matches!(ev.event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        continue;
                    }
                    for p in &ev.event.paths {
                        if let Some(snapshot) = read_valid_snapshot(&watch_root, p) {
                            on_snapshot(snapshot);
                        }
                    }
                }
            }
            Err(errors) => {
                eprintln!("statusline_snapshot watcher errors: {errors:?}");
            }
        },
    )
    .map_err(|e| format!("failed to create debouncer: {e}"))?;

    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {e}", root.display()))?;

    // Move the debouncer into a thread and park the thread so it outlives
    // this function call — same lifetime trick as `session_watcher::install`.
    std::thread::spawn(move || {
        let _hold = debouncer;
        std::thread::park();
    });

    Ok(())
}

/// Install the global status-snapshot watcher. Runs in its own OS thread
/// (via the caller — see `lib.rs`'s `.setup()`, which spawns this exactly
/// like `session_watcher::install`); the debouncer itself is parked in a
/// second thread spawned from `install_watching_dir` and kept alive for the
/// lifetime of the app.
pub fn install(app: AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data directory: {e}"))?;
    let root = app_data_dir.join(STATUS_SNAPSHOTS_DIR_NAME);

    let app_handler = app.clone();
    install_watching_dir(root, move |snapshot| {
        let _ = app_handler.emit("usage:snapshot", snapshot);
    })
}

// ---------------------------------------------------------------------
// Part B — the read command
// ---------------------------------------------------------------------

/// Reads `<dir>/<tab_id>.json` and parses it as a `UsageSnapshot`. Missing
/// file and parse failure are treated identically — both just mean "no
/// usable data for this tab yet".
fn read_tab_snapshot(dir: &Path, tab_id: &str) -> Option<UsageSnapshot> {
    let bytes = fs::read(dir.join(format!("{tab_id}.json"))).ok()?;
    serde_json::from_slice::<UsageSnapshot>(&bytes).ok()
}

/// Scans every `*.json` file directly under `dir` (every tab's snapshot for
/// this profile, including the caller's own) and returns the `rate_limits`
/// from whichever one has the maximum `observed_at` among files that carry
/// `rate_limits` at all. Files with no `rate_limits` (or that fail to parse)
/// are not candidates and never win regardless of how fresh their
/// `observed_at` is — rate limits describe the shared account, so a file
/// that never observed them has nothing to contribute.
fn freshest_rate_limits(dir: &Path) -> Option<ProfileRateLimits> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<ProfileRateLimits> = None;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Ok(snapshot) = serde_json::from_slice::<UsageSnapshot>(&bytes) else {
            continue;
        };
        let Some(rate_limits) = snapshot.rate_limits else {
            continue;
        };
        let is_fresher = match &best {
            Some(current) => snapshot.observed_at > current.observed_at,
            None => true,
        };
        if is_fresher {
            best = Some(ProfileRateLimits {
                rate_limits,
                observed_at: snapshot.observed_at,
            });
        }
    }

    best
}

/// Builds the full `TabStatusView` for `tab_id` out of `dir` (already the
/// resolved `<app_data_dir>/status-snapshots/<profile_hash>` directory).
/// Pure filesystem logic taking a plain `&Path`, so it's testable without a
/// real `AppHandle` — see `tests::read_command`. `dir` not existing at all
/// (no snapshot has ever been written for this profile) is not an error:
/// both fields simply come back `None`, since `fs::read_dir` on a missing
/// directory just yields no entries below.
fn read_tab_status_view(dir: &Path, tab_id: &str) -> TabStatusView {
    TabStatusView {
        tab: read_tab_snapshot(dir, tab_id),
        profile_rate_limits: freshest_rate_limits(dir),
    }
}

/// Best-effort removal of any `<status-snapshots>/<profile_hash>/*.json`
/// file whose mtime is older than `ttl`, across every profile — not just
/// whichever one the caller happens to be reading. Called opportunistically
/// at the start of `read_status_snapshot` rather than from a background
/// timer, so stale files (an old tab that will never write again, an
/// abandoned custom profile) self-heal without a dedicated pruning thread.
/// Any I/O error along the way — an unreadable directory, a permission
/// issue, a file removed by something else between listing and removing it
/// — is swallowed; this is disk hygiene, not something worth surfacing as a
/// command error.
pub fn prune_stale_snapshots(app_data_dir: &Path, ttl: Duration) {
    let root = app_data_dir.join(STATUS_SNAPSHOTS_DIR_NAME);
    let Ok(profile_dirs) = fs::read_dir(&root) else {
        return;
    };
    let now = SystemTime::now();

    for profile_dir in profile_dirs.flatten() {
        let profile_path = profile_dir.path();
        if !profile_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&profile_path) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let is_stale = fs::metadata(&path)
                .and_then(|m| m.modified())
                .map(|modified| now.duration_since(modified).unwrap_or_default() > ttl)
                .unwrap_or(false);
            if is_stale {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// Tauri command: fetch `tab_id`'s own snapshot plus the profile's freshest
/// rate-limit window.
///
/// Takes `profile_id` (e.g. `"default"` or `"custom:base64..."`) and
/// `tab_id` directly, never a pre-computed hash — the hash is an
/// implementation detail of where snapshots live on disk, computed here via
/// `usage_snapshot::profile_hash`, so callers never need to know or
/// reproduce it themselves.
#[tauri::command]
pub fn read_status_snapshot(
    app: AppHandle,
    profile_id: String,
    tab_id: String,
) -> Result<TabStatusView, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data directory: {e}"))?;

    // Cheap enough to run on every call; means stale files self-heal
    // without a background timer. Best-effort — never fails this command.
    prune_stale_snapshots(&app_data_dir, DEFAULT_SNAPSHOT_TTL);

    let hash = profile_hash(&profile_id);
    let dir = app_data_dir.join(STATUS_SNAPSHOTS_DIR_NAME).join(hash);
    Ok(read_tab_status_view(&dir, &tab_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A directory under the OS temp dir, removed on drop. Same pattern as
    /// `sessions.rs`/`project_env.rs`'s test helper.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "klaudio-statusline-snapshot-test-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_snapshot(
        tab_id: &str,
        observed_at: u64,
        rate_limits: Option<RateLimitWindows>,
    ) -> UsageSnapshot {
        UsageSnapshot {
            provider_id: "claude".into(),
            tab_id: tab_id.into(),
            session_id: Some(format!("sess-{tab_id}")),
            observed_at,
            model: None,
            context: None,
            rate_limits,
        }
    }

    fn rate_limits(five_hour_pct: f32) -> RateLimitWindows {
        RateLimitWindows {
            five_hour: Some(crate::usage_snapshot::RateWindow {
                used_percentage: five_hour_pct,
                resets_at: 1_700_000_000,
            }),
            seven_day: None,
        }
    }

    fn write_snapshot_file(dir: &Path, tab_id: &str, snapshot: &UsageSnapshot) {
        fs::create_dir_all(dir).unwrap();
        let json = serde_json::to_vec(snapshot).unwrap();
        fs::write(dir.join(format!("{tab_id}.json")), json).unwrap();
    }

    /// Sets a file's mtime to `age` in the past — used to simulate a stale
    /// snapshot for `prune_stale_snapshots` without depending on an external
    /// crate. `std::fs::FileTimes`/`File::set_times` has been stable since
    /// Rust 1.75.
    fn backdate_mtime(path: &Path, age: Duration) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        let then = SystemTime::now() - age;
        let times = fs::FileTimes::new().set_modified(then);
        file.set_times(times).unwrap();
    }

    mod read_command {
        use super::*;

        #[test]
        fn missing_directory_yields_all_none() {
            let root = TempDir::new("missing-dir");
            let never_created = root.path().join("does-not-exist");

            let view = read_tab_status_view(&never_created, "tab-1");

            assert!(view.tab.is_none());
            assert!(view.profile_rate_limits.is_none());
        }

        #[test]
        fn own_valid_file_is_returned_as_tab() {
            let root = TempDir::new("own-file-valid");
            let snapshot = sample_snapshot("tab-1", 1_000, None);
            write_snapshot_file(root.path(), "tab-1", &snapshot);

            let view = read_tab_status_view(root.path(), "tab-1");

            let tab = view.tab.expect("tab snapshot must parse");
            assert_eq!(tab.tab_id, "tab-1");
            assert_eq!(tab.session_id.as_deref(), Some("sess-tab-1"));
            assert_eq!(tab.observed_at, 1_000);
        }

        #[test]
        fn malformed_own_file_yields_none_not_error() {
            let root = TempDir::new("own-file-malformed");
            fs::create_dir_all(root.path()).unwrap();
            fs::write(root.path().join("tab-1.json"), b"{not valid json").unwrap();

            let view = read_tab_status_view(root.path(), "tab-1");

            assert!(view.tab.is_none());
        }

        #[test]
        fn profile_rate_limits_picks_max_observed_at_not_own_file_or_filename_order() {
            let root = TempDir::new("max-observed-at");

            // The caller's own tab has an *older* observation than another
            // tab's file — the merge must still prefer the other tab's.
            let own = sample_snapshot("tab-a", 1_000, Some(rate_limits(10.0)));
            write_snapshot_file(root.path(), "tab-a", &own);

            let fresher = sample_snapshot("tab-z", 5_000, Some(rate_limits(77.0)));
            write_snapshot_file(root.path(), "tab-z", &fresher);

            let middle = sample_snapshot("tab-m", 3_000, Some(rate_limits(40.0)));
            write_snapshot_file(root.path(), "tab-m", &middle);

            let view = read_tab_status_view(root.path(), "tab-a");

            let merged = view
                .profile_rate_limits
                .expect("at least one file carries rate_limits");
            assert_eq!(merged.observed_at, 5_000);
            assert_eq!(merged.rate_limits.five_hour.unwrap().used_percentage, 77.0);
        }

        #[test]
        fn file_without_rate_limits_is_ignored_even_if_fresher() {
            let root = TempDir::new("ignore-no-rate-limits");

            // Fresher observed_at, but carries no rate_limits at all — must
            // never win over an older file that does.
            let fresher_but_empty = sample_snapshot("tab-fresh", 9_000, None);
            write_snapshot_file(root.path(), "tab-fresh", &fresher_but_empty);

            let older_with_limits = sample_snapshot("tab-old", 1_000, Some(rate_limits(22.0)));
            write_snapshot_file(root.path(), "tab-old", &older_with_limits);

            let view = read_tab_status_view(root.path(), "tab-fresh");

            let merged = view
                .profile_rate_limits
                .expect("the file that has rate_limits must still be found");
            assert_eq!(merged.observed_at, 1_000);
            assert_eq!(merged.rate_limits.five_hour.unwrap().used_percentage, 22.0);
        }

        #[test]
        fn no_file_carries_rate_limits_yields_none() {
            let root = TempDir::new("no-rate-limits-anywhere");
            let snap = sample_snapshot("tab-1", 1_000, None);
            write_snapshot_file(root.path(), "tab-1", &snap);

            let view = read_tab_status_view(root.path(), "tab-1");

            assert!(view.profile_rate_limits.is_none());
        }

        #[test]
        fn prune_removes_only_stale_files() {
            let app_data_dir = TempDir::new("prune-app-data");
            let profile_dir = app_data_dir
                .path()
                .join(STATUS_SNAPSHOTS_DIR_NAME)
                .join("some-profile-hash");
            fs::create_dir_all(&profile_dir).unwrap();

            let fresh_path = profile_dir.join("fresh-tab.json");
            fs::write(&fresh_path, b"{}").unwrap();

            let stale_path = profile_dir.join("stale-tab.json");
            fs::write(&stale_path, b"{}").unwrap();
            backdate_mtime(&stale_path, Duration::from_secs(3600));

            prune_stale_snapshots(app_data_dir.path(), Duration::from_secs(60));

            assert!(fresh_path.exists(), "fresh file must survive pruning");
            assert!(!stale_path.exists(), "stale file must be removed");
        }
    }

    mod watcher {
        use super::*;
        use std::time::Instant;

        const WAIT_TIMEOUT: Duration = Duration::from_secs(5);
        // Comfortably above DEBOUNCE_MS: a retry interval shorter than the
        // debounce window risks re-writing the file while the previous
        // write's debounce tick is still pending, which can straddle two
        // ticks and deliver more than one callback for what the test
        // considers a single logical write.
        const RETRY_INTERVAL: Duration = Duration::from_millis(DEBOUNCE_MS + 150);

        /// Writes `snapshot` into `dir` (creating it if needed) repeatedly
        /// until `rx` observes a callback or `overall_timeout` elapses.
        ///
        /// A single write-then-wait is not reliable for a `dir` that didn't
        /// exist before this call: inotify's recursive watcher only learns
        /// about a brand-new subdirectory from its own `Create(Folder)`
        /// event and registers a watch for it asynchronously relative to
        /// that event, so a write landing immediately after `mkdir` can race
        /// that registration and be missed entirely — not delayed, lost
        /// (see this module's doc comment). Retrying the same write is a
        /// deterministic way to get past that window without an unbounded
        /// sleep: once the watch is actually active, the next attempt's
        /// events are observed like any other file's.
        fn write_until_observed(
            dir: &Path,
            tab_id: &str,
            snapshot: &UsageSnapshot,
            rx: &mpsc::Receiver<UsageSnapshot>,
            overall_timeout: Duration,
        ) -> UsageSnapshot {
            let deadline = Instant::now() + overall_timeout;
            loop {
                write_snapshot_file(dir, tab_id, snapshot);
                match rx.recv_timeout(RETRY_INTERVAL) {
                    Ok(received) => return received,
                    Err(_) => assert!(
                        Instant::now() < deadline,
                        "no snapshot for {tab_id} observed within {overall_timeout:?}"
                    ),
                }
            }
        }

        #[test]
        fn valid_snapshot_file_triggers_callback() {
            let root = TempDir::new("watcher-valid");
            let (tx, rx) = mpsc::channel::<UsageSnapshot>();

            install_watching_dir(root.path().to_path_buf(), move |snapshot| {
                let _ = tx.send(snapshot);
            })
            .expect("install must succeed");

            let profile_dir = root.path().join("profile-hash-1");
            let snapshot = sample_snapshot("tab-1", 42, None);
            let received =
                write_until_observed(&profile_dir, "tab-1", &snapshot, &rx, WAIT_TIMEOUT);

            assert_eq!(received.tab_id, "tab-1");
            assert_eq!(received.observed_at, 42);
        }

        #[test]
        fn malformed_snapshot_file_never_triggers_callback() {
            let root = TempDir::new("watcher-malformed");
            let (tx, rx) = mpsc::channel::<UsageSnapshot>();

            install_watching_dir(root.path().to_path_buf(), move |snapshot| {
                let _ = tx.send(snapshot);
            })
            .expect("install must succeed");

            // Warm up the directory's watch first (see `write_until_observed`
            // docs on the new-subdirectory race) with a throwaway valid
            // write, so the malformed write below is guaranteed to land on
            // an already-active watch — otherwise "no callback fired" could
            // pass for the wrong reason (the event lost to the race) rather
            // than because malformed JSON was correctly filtered out.
            let profile_dir = root.path().join("profile-hash-2");
            let warmup = sample_snapshot("__warmup__", 0, None);
            write_until_observed(&profile_dir, "__warmup__", &warmup, &rx, WAIT_TIMEOUT);
            // Let one more full debounce tick pass and drain anything it
            // delivers, so a trailing coalesced event from the warmup write
            // (or its retries) can never land inside the "no event" window
            // asserted below and be mistaken for a reaction to the
            // malformed write that hasn't been written yet.
            std::thread::sleep(Duration::from_millis(DEBOUNCE_MS + 150));
            while rx.try_recv().is_ok() {}

            let mut f = fs::File::create(profile_dir.join("tab-bad.json")).unwrap();
            f.write_all(b"{not valid json at all").unwrap();
            drop(f);

            assert!(
                rx.recv_timeout(Duration::from_millis(800)).is_err(),
                "malformed JSON must never reach the callback"
            );

            // A subsequent valid write on the same (already-watched)
            // directory must still work.
            let good = sample_snapshot("tab-good", 7, None);
            write_snapshot_file(&profile_dir, "tab-good", &good);
            let received = rx
                .recv_timeout(WAIT_TIMEOUT)
                .expect("a subsequent valid write must still be observed");
            assert_eq!(received.tab_id, "tab-good");
        }

        #[test]
        fn subdirectory_created_after_install_is_still_watched() {
            let root = TempDir::new("watcher-new-subdir");
            let (tx, rx) = mpsc::channel::<UsageSnapshot>();

            install_watching_dir(root.path().to_path_buf(), move |snapshot| {
                let _ = tx.send(snapshot);
            })
            .expect("install must succeed");

            // This profile-hash directory does not exist yet at watch-install
            // time — proves RecursiveMode::Recursive eventually covers
            // directories created after the initial watch() call, not just
            // what existed then (see `write_until_observed` for why this
            // retries rather than writing once).
            let new_profile_dir = root.path().join("brand-new-profile-hash");
            let snapshot = sample_snapshot("tab-in-new-dir", 99, None);
            let received = write_until_observed(
                &new_profile_dir,
                "tab-in-new-dir",
                &snapshot,
                &rx,
                WAIT_TIMEOUT,
            );

            assert_eq!(received.tab_id, "tab-in-new-dir");
            assert_eq!(received.observed_at, 99);
        }
    }
}
