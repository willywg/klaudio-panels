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

/// Socket the shim reports to. Kept in the cache dir so the whole path stays
/// well under the ~104 byte `sun_path` limit.
pub fn socket_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|c| c.join("klaudio-panels/clip.sock"))
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
pub fn install(app: AppHandle) {
    if let Err(e) = write_shim() {
        debug_log::write("clipboard", &format!("shim install failed: {e}"));
    }
    std::thread::spawn(move || {
        if let Err(e) = listen(app) {
            debug_log::write("clipboard", &format!("listener failed: {e}"));
        }
    });
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

fn listen(app: AppHandle) -> std::io::Result<()> {
    let Some(path) = socket_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // A socket file left behind by a previous run (crash, SIGKILL) would make
    // bind fail with EADDRINUSE even though nothing is listening.
    let _ = std::fs::remove_file(&path);

    let listener = UnixListener::bind(&path)?;
    debug_log::write("clipboard", "shim listener ready");

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
    Ok(())
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
