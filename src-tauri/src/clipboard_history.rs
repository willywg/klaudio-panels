//! In-memory clipboard history, recording only what Klaudio itself copies.
//!
//! An earlier cut of this watched the system pasteboard by polling
//! `NSPasteboard.changeCount`. That worked, but it recorded *everything* —
//! a copy from Safari, a WhatsApp message, a password — because the
//! pasteboard exposes no attribution: `changeCount` tells you that a write
//! happened, never who made it. Filtering by origin is therefore not a
//! predicate we can add to a watcher; it requires owning the write.
//!
//! So we do. Two sources, both ours by construction:
//!
//! 1. **`pbcopy` inside a Klaudio terminal.** `spawn_pty` prepends a
//!    Klaudio-owned directory to every PTY's `PATH`, holding a `pbcopy` shim
//!    that tees its stdin to the real `/usr/bin/pbcopy` and to the socket we
//!    listen on here. This is what catches Claude handing something over,
//!    and it works whether or not Klaudio is the frontmost app.
//! 2. **⌘C in a Klaudio terminal**, reported by the frontend through
//!    `clipboard_record` — that copy path is already our own code.
//!
//! Nothing else can reach the ring, which is also why none of the
//! `org.nspasteboard.*` concealed-write machinery survives: we never read
//! the system pasteboard, so a password manager's clip is not something we
//! could capture even by accident.
//!
//! Nothing is written to disk either. The ring dies with the process.

use std::collections::VecDeque;
use std::io::Read;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::debug_log;

const MAX_ENTRIES: usize = 10;

/// Per-entry cap. Generous for the emails, snippets and command output this
/// exists to catch, while keeping the worst case bounded at 640KB resident.
const MAX_TEXT_BYTES: usize = 64 * 1024;

/// Hard ceiling on a single socket read, so a runaway writer cannot make us
/// buffer without bound before `normalize` gets a chance to truncate.
const MAX_SOCKET_READ: u64 = (MAX_TEXT_BYTES * 2) as u64;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClipEntry {
    pub id: u64,
    pub text: String,
    pub copied_at_ms: u64,
    /// The source text exceeded `MAX_TEXT_BYTES` and `text` is a prefix.
    pub truncated: bool,
}

static HISTORY: LazyLock<Mutex<VecDeque<ClipEntry>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

/// Recording is on by default; the frontend restores the user's choice at
/// boot, before any PTY can be spawned.
static ENABLED: AtomicBool = AtomicBool::new(true);

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Whether this instance owns the socket the `pbcopy` shim reports to.
///
/// False when another Klaudio got there first. It gates two things that would
/// otherwise be lies: the panel says recording is unavailable, and `pty.rs`
/// withholds `KLAUDIO_CLIP_SOCK` so a terminal copy falls through to the real
/// `pbcopy` rather than surfacing in a different window's list (#96).
static SHIM_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Whether terminal copies reach this window's history.
pub fn shim_active() -> bool {
    SHIM_ACTIVE.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn clipboard_shim_active() -> bool {
    shim_active()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reject whitespace-only copies and cap the rest. Returns the stored text
/// and whether it was cut short.
pub(crate) fn normalize(text: &str) -> Option<(String, bool)> {
    if text.trim().is_empty() {
        return None;
    }
    if text.len() <= MAX_TEXT_BYTES {
        return Some((text.to_string(), false));
    }
    // Back off to a char boundary at or below the cap — slicing mid-codepoint
    // panics.
    let mut end = MAX_TEXT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    Some((text[..end].to_string(), true))
}

/// Newest-first insertion. Re-copying something already held promotes it
/// instead of producing a duplicate row, which is what makes a 10-entry
/// window useful rather than a log.
pub(crate) fn insert_entry(ring: &mut VecDeque<ClipEntry>, entry: ClipEntry) {
    if let Some(pos) = ring.iter().position(|e| e.text == entry.text) {
        ring.remove(pos);
    }
    ring.push_front(entry);
    while ring.len() > MAX_ENTRIES {
        ring.pop_back();
    }
}

/// Shared entry point for both sources. No-op when recording is off.
fn record(app: &AppHandle, raw: &str) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some((text, truncated)) = normalize(raw) else {
        return;
    };
    let entry = ClipEntry {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        text,
        copied_at_ms: now_ms(),
        truncated,
    };
    if let Ok(mut h) = HISTORY.lock() {
        insert_entry(&mut h, entry.clone());
    }
    let _ = app.emit("clipboard:new", entry);
}

/// Reported by the frontend for ⌘C inside a Klaudio terminal.
#[tauri::command]
pub fn clipboard_record(app: AppHandle, text: String) {
    record(&app, &text);
}

#[tauri::command]
pub fn clipboard_history_list() -> Vec<ClipEntry> {
    HISTORY
        .lock()
        .map(|h| h.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn clipboard_history_clear() {
    if let Ok(mut h) = HISTORY.lock() {
        h.clear();
    }
}

#[tauri::command]
pub fn clipboard_history_set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Directory prepended to every PTY's `PATH`, holding the `pbcopy` shim.
pub fn shim_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|c| c.join("klaudio-panels/bin"))
}

/// FNV-1a, folded to 32 bits and rendered as 8 hex characters.
///
/// Written out rather than reaching for `DefaultHasher`: that one is
/// explicitly not stable across Rust releases, and this value names a file
/// that has to survive a toolchain upgrade. An unstable hash would strand the
/// previous socket in the cache dir on every rebuild.
fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

/// Identifies this *installation* — the bundle the running process came from.
///
/// Two Klaudios on one machine are ordinary: the one in `/Applications`
/// alongside a `tauri dev` build, or a copy still running from a mounted DMG
/// while the installed one is open. They are different installs and must not
/// share a socket, or the second to boot takes the first one's `pbcopy` away
/// (#96). Keyed on the executable path, so it is stable across restarts —
/// one socket per install, not one per run.
fn install_key() -> String {
    std::env::current_exe()
        .map(|p| short_hash(&p.to_string_lossy()))
        .unwrap_or_else(|_| "default".to_string())
}

/// Socket the shim reports to. Kept in the cache dir so the whole path stays
/// well under the ~104 byte `sun_path` limit.
pub fn socket_path() -> Option<PathBuf> {
    dirs::cache_dir()
        .map(|c| c.join(format!("klaudio-panels/clip-{}.sock", install_key())))
}

/// The single shared socket every version through v1.10.1 used. Left behind
/// on upgrade, and nothing will ever bind it again.
fn legacy_socket_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|c| c.join("klaudio-panels/clip.sock"))
}

/// Whether a socket file has a live listener behind it.
///
/// This is the distinction the old unconditional `remove_file` could not
/// make. Removing an *abandoned* socket is necessary — `bind` fails with
/// `EADDRINUSE` on a leftover from a crash even though nothing is listening.
/// Removing a *live* one unlinks the name out from under a running instance,
/// whose listener then survives on a socket nothing can reach (#96).
fn has_live_listener(path: &std::path::Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}

/// `pbcopy` replacement placed ahead of `/usr/bin` on the PTY's `PATH`.
///
/// Every branch falls through to the real `pbcopy`, and its exit status is
/// what we return: recording is strictly best-effort, and breaking the user's
/// `pbcopy` to feed a history panel would be a terrible trade. `tee` into a
/// process substitution keeps the payload off disk — a clip may well be a
/// secret, and it has no business in a temp file.
const PBCOPY_SHIM: &str = r#"#!/bin/bash
# Klaudio Panels — pbcopy shim. Tees the clip to Klaudio's clipboard history
# and then hands it to the real pbcopy unchanged. Generated at app boot; edits
# here are overwritten. Removing this file only disables the history.
if [ -n "$KLAUDIO_CLIP_SOCK" ] && [ -S "$KLAUDIO_CLIP_SOCK" ] &&
   command -v nc >/dev/null 2>&1; then
  tee >(nc -U "$KLAUDIO_CLIP_SOCK" >/dev/null 2>&1) | /usr/bin/pbcopy "$@"
  exit "${PIPESTATUS[1]}"
fi
exec /usr/bin/pbcopy "$@"
"#;

/// Write the shim and start the listener. Safe to call once at boot.
///
/// The bind happens here, synchronously, and only the accept loop is
/// backgrounded. `pty.rs` reads `shim_active()` to decide whether to hand a
/// child `KLAUDIO_CLIP_SOCK`, and binding on the worker thread would leave a
/// PTY opened in the first instants after boot reading a flag that had not
/// settled yet.
pub fn install(app: AppHandle) {
    if let Err(e) = write_shim() {
        debug_log::write("clipboard", &format!("shim install failed: {e}"));
    }
    match bind_listener() {
        Ok(Some(listener)) => {
            SHIM_ACTIVE.store(true, Ordering::Relaxed);
            debug_log::write("clipboard", "shim listener ready");
            std::thread::spawn(move || accept_loop(&app, &listener));
        }
        // Another Klaudio owns the socket. Already logged; leaving
        // SHIM_ACTIVE false is what keeps us from claiming to record.
        Ok(None) => {}
        Err(e) => {
            debug_log::write("clipboard", &format!("listener failed: {e}"));
        }
    }
}

fn write_shim() -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let Some(dir) = shim_dir() else {
        return Ok(());
    };
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("pbcopy");
    std::fs::write(&path, PBCOPY_SHIM)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

/// Claim this installation's socket.
///
/// `Ok(None)` means another Klaudio is already listening on it — the same
/// binary launched twice, since a second *install* gets its own path. We
/// decline rather than take it over: stealing is what made a whole day of
/// clips disappear from a window that still said it was recording (#96).
fn bind_listener() -> std::io::Result<Option<UnixListener>> {
    let Some(path) = socket_path() else {
        return Ok(None);
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Tidy up the single shared socket older versions used, but only once it
    // is certain nobody is behind it — during an upgrade the previous version
    // may still be running on it.
    if let Some(legacy) = legacy_socket_path() {
        if legacy.exists() && !has_live_listener(&legacy) {
            let _ = std::fs::remove_file(&legacy);
        }
    }

    if has_live_listener(&path) {
        debug_log::write(
            "clipboard",
            "another Klaudio owns this install's clipboard socket; not recording",
        );
        return Ok(None);
    }
    // Nothing listening, so whatever is here is a leftover from a crash or a
    // SIGKILL. `bind` fails with EADDRINUSE on it otherwise.
    let _ = std::fs::remove_file(&path);

    Ok(Some(UnixListener::bind(&path)?))
}

fn accept_loop(app: &AppHandle, listener: &UnixListener) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let app = app.clone();
        // One short-lived thread per clip: a writer that opens the socket and
        // then stalls must not wedge the accept loop for every later copy.
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if stream
                .by_ref()
                .take(MAX_SOCKET_READ)
                .read_to_end(&mut buf)
                .is_err()
            {
                return;
            }
            // Text only — a piped image or other binary payload is not
            // something this panel can show or hand back.
            if let Ok(text) = String::from_utf8(buf) {
                record(&app, &text);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: u64, text: &str) -> ClipEntry {
        ClipEntry {
            id,
            text: text.to_string(),
            copied_at_ms: 0,
            truncated: false,
        }
    }

    #[test]
    fn whitespace_only_copies_are_dropped() {
        assert_eq!(normalize(""), None);
        assert_eq!(normalize("   \n\t "), None);
        assert_eq!(
            normalize("  hello  "),
            Some(("  hello  ".to_string(), false))
        );
    }

    #[test]
    fn oversized_text_is_cut_on_a_char_boundary() {
        // A multi-byte char straddling the cap must not panic the slice.
        let big = "á".repeat(MAX_TEXT_BYTES);
        let (text, truncated) = normalize(&big).expect("non-empty");
        assert!(truncated);
        assert!(text.len() <= MAX_TEXT_BYTES);
        assert!(big.starts_with(&text));
    }

    #[test]
    fn newest_entry_comes_first() {
        let mut ring = VecDeque::new();
        insert_entry(&mut ring, entry(1, "first"));
        insert_entry(&mut ring, entry(2, "second"));
        assert_eq!(ring[0].text, "second");
        assert_eq!(ring[1].text, "first");
    }

    #[test]
    fn recopying_promotes_instead_of_duplicating() {
        let mut ring = VecDeque::new();
        insert_entry(&mut ring, entry(1, "a"));
        insert_entry(&mut ring, entry(2, "b"));
        insert_entry(&mut ring, entry(3, "a"));
        assert_eq!(ring.len(), 2);
        assert_eq!(ring[0].text, "a");
        assert_eq!(ring[0].id, 3, "promoted entry carries the new id");
        assert_eq!(ring[1].text, "b");
    }

    #[test]
    fn the_ring_never_grows_past_its_cap() {
        let mut ring = VecDeque::new();
        for i in 0..(MAX_ENTRIES as u64 + 5) {
            insert_entry(&mut ring, entry(i, &format!("entry {i}")));
        }
        assert_eq!(ring.len(), MAX_ENTRIES);
        assert_eq!(ring[0].text, format!("entry {}", MAX_ENTRIES + 4));
        assert_eq!(ring[MAX_ENTRIES - 1].text, format!("entry {}", 5));
    }

    /// The shim's contract is what keeps a broken history from becoming a
    /// broken `pbcopy`, so assert the properties that guarantee it.
    #[test]
    fn the_shim_always_reaches_the_real_pbcopy() {
        // Both the recording branch and the fallback invoke it.
        assert_eq!(PBCOPY_SHIM.matches("/usr/bin/pbcopy").count(), 2);
        // Arguments are forwarded verbatim on both branches (`pbcopy -pboard
        // find` must keep working).
        assert_eq!(PBCOPY_SHIM.matches(r#""$@""#).count(), 2);
        // The real pbcopy's exit status is what the caller sees.
        assert!(PBCOPY_SHIM.contains(r#"exit "${PIPESTATUS[1]}""#));
        // No temp file: a clip may be a secret and must not touch disk.
        assert!(!PBCOPY_SHIM.contains("mktemp"));
        // Missing socket or missing nc falls through instead of failing.
        assert!(PBCOPY_SHIM.contains("-S \"$KLAUDIO_CLIP_SOCK\""));
        assert!(PBCOPY_SHIM.contains("command -v nc"));
        // bash, not sh — process substitution and PIPESTATUS need it.
        assert!(PBCOPY_SHIM.starts_with("#!/bin/bash\n"));
    }

    #[test]
    fn each_install_gets_its_own_socket() {
        // The whole point of #96: the app in /Applications and a dev build
        // are different installs, and sharing one socket meant the second to
        // boot took the first one's `pbcopy` away.
        let installed = short_hash("/Applications/Klaudio Panels.app/Contents/MacOS/klaudio-panels");
        let dev = short_hash("/Users/me/proyectos/claude-desktop/src-tauri/target/debug/klaudio-panels");
        assert_ne!(installed, dev);
    }

    #[test]
    fn the_install_key_is_stable_for_one_path() {
        // It names a file that has to be found again after a restart, and
        // after a toolchain upgrade — hence FNV rather than DefaultHasher.
        let p = "/Applications/Klaudio Panels.app/Contents/MacOS/klaudio-panels";
        assert_eq!(short_hash(p), short_hash(p));
        assert_eq!(short_hash(p).len(), 8);
        assert!(short_hash(p).chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn an_absent_socket_has_no_live_listener() {
        // The predicate that replaced the unconditional `remove_file`. A
        // missing path must read as "safe to bind", not as "someone is
        // there", or a first run would decline to record at all.
        let dir = std::env::temp_dir().join("klaudio-clip-probe-absent");
        let _ = std::fs::remove_file(&dir);
        assert!(!has_live_listener(&dir));
    }

    #[test]
    fn a_bound_socket_reads_as_live_and_a_dead_one_does_not() {
        let path = std::env::temp_dir().join("klaudio-clip-probe-live.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        assert!(
            has_live_listener(&path),
            "a bound socket must be seen as live, or we would unlink it"
        );
        // Dropping the listener leaves the file behind — exactly the crash
        // leftover the unlink exists for.
        drop(listener);
        assert!(path.exists());
        assert!(!has_live_listener(&path));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_socket_path_fits_in_sun_path() {
        // Unix domain socket paths are capped around 104 bytes on macOS;
        // exceeding it fails at bind time with a confusing error.
        if let Some(p) = socket_path() {
            assert!(
                p.as_os_str().len() < 100,
                "socket path too long: {}",
                p.display()
            );
        }
    }
}
