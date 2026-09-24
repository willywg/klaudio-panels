//! Per-install Unix sockets.
//!
//! Two Klaudios on one machine are ordinary (the app in `/Applications` next
//! to a `tauri dev` build). They must not share a socket: the second to boot
//! would unlink the name out from under the first (#96). The key is the
//! executable path, so it is stable across restarts and toolchain upgrades.

use std::io;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

/// FNV-1a, folded to 32 bits and rendered as 8 hex characters.
///
/// Written out rather than reaching for `DefaultHasher`: that one is
/// explicitly not stable across Rust releases, and this value names a file
/// that has to survive a toolchain upgrade.
pub(crate) fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

/// Identifies this installation — the bundle the running process came from.
pub(crate) fn install_key() -> String {
    std::env::current_exe()
        .map(|p| short_hash(&p.to_string_lossy()))
        .unwrap_or_else(|_| "default".to_string())
}

/// Whether a socket file has a live listener behind it.
///
/// Removing an abandoned socket is necessary — `bind` fails with
/// `EADDRINUSE` on a leftover from a crash even though nothing is listening.
/// Removing a live one unlinks the name out from under a running instance.
pub(crate) fn has_live_listener(path: &Path) -> bool {
    UnixStream::connect(path).is_ok()
}

/// Bind `path`, refusing to take it from a live listener.
///
/// `Ok(None)` means another process is already listening. A leftover file
/// with nobody behind it is removed first.
pub(crate) fn bind_exclusive(path: &Path) -> io::Result<Option<UnixListener>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if has_live_listener(path) {
        return Ok(None);
    }
    let _ = std::fs::remove_file(path);
    Ok(Some(UnixListener::bind(path)?))
}

pub(crate) fn cache_socket(name: &str) -> Option<PathBuf> {
    dirs::cache_dir().map(|c| c.join(format!("klaudio-panels/{name}-{}.sock", install_key())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_install_gets_its_own_key() {
        let installed =
            short_hash("/Applications/Klaudio Panels.app/Contents/MacOS/klaudio-panels");
        let dev =
            short_hash("/Users/me/proyectos/claude-desktop/src-tauri/target/debug/klaudio-panels");
        assert_ne!(installed, dev);
    }

    #[test]
    fn the_install_key_is_stable_for_one_path() {
        let p = "/Applications/Klaudio Panels.app/Contents/MacOS/klaudio-panels";
        assert_eq!(short_hash(p), short_hash(p));
        assert_eq!(short_hash(p).len(), 8);
        assert!(short_hash(p).chars().all(|c| c.is_ascii_hexdigit()));
    }

    fn probe_path(name: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "klaudio-socket-{name}-{}-{}.sock",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn an_absent_socket_has_no_live_listener() {
        let path = probe_path("absent");
        let _ = std::fs::remove_file(&path);
        assert!(!has_live_listener(&path));
    }

    #[test]
    fn a_bound_socket_reads_as_live_and_a_dead_one_does_not() {
        let path = probe_path("live");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        assert!(has_live_listener(&path));
        drop(listener);
        assert!(path.exists());
        let mut dead = false;
        for _ in 0..50 {
            if !has_live_listener(&path) {
                dead = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(dead, "a dropped listener must not still accept");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn bind_exclusive_refuses_a_live_socket_and_reclaims_a_dead_one() {
        let path = probe_path("claim");
        let _ = std::fs::remove_file(&path);
        let first = bind_exclusive(&path).expect("first bind").expect("claimed");
        assert!(bind_exclusive(&path).expect("second").is_none());
        drop(first);
        // Closing the listener and the kernel noticing are not the same
        // instant. Under a loaded test run the next connect can still
        // succeed for a moment.
        let mut reclaimed = false;
        for _ in 0..50 {
            if bind_exclusive(&path).expect("reclaim").is_some() {
                reclaimed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(reclaimed, "a dead socket should be reclaimable");
        let _ = std::fs::remove_file(&path);
    }
}
