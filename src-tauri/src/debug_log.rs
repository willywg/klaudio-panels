//! File-based diagnostic log. Writes to
//! `~/Library/Logs/Klaudio Panels/klaudio.log` on macOS so end-users can ship
//! their log without enabling dev tools. Also mirrors to stderr when we're
//! running under `bun tauri dev` for live tail-ability.
//!
//! The file rotates by size. `klaudio.log` is archived to `klaudio.log.1`
//! (shifting `.1`→`.2`→`.3`, three generations) once the byte counter passes
//! 5 MB. The counter is checked every few dozen writes, and the file is
//! `stat`ed only when the writer is first opened — not on every line. A log
//! that is already far past the limit (the 111 MB file from #115) is rotated
//! on that first write and only its tail is kept, so one launch bounds the
//! directory. `get_log_path` always returns the live `klaudio.log` path.
//!
//! Tests call [`LogState::append`] with a directory they created. They must
//! not call [`write`], which targets the real log directory.

use std::borrow::Cow;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const LOG_NAME: &str = "klaudio.log";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const GENERATIONS: u32 = 3;
/// How many appends between size checks. The check itself is the in-memory
/// counter, not a `stat`.
const CHECK_EVERY_WRITES: u32 = 32;
const MAX_MSG_BYTES: usize = 16 * 1024;
const TRUNCATED_SUFFIX: &str = "... [truncated]";

fn log_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    #[cfg(target_os = "macos")]
    let dir = home.join("Library/Logs/Klaudio Panels");
    #[cfg(not(target_os = "macos"))]
    let dir = home.join(".klaudio-panels").join("logs");
    Some(dir)
}

pub fn log_file_path() -> Option<PathBuf> {
    log_dir().map(|d| d.join(LOG_NAME))
}

struct LogState {
    file: Option<File>,
    tracked_len: u64,
    writes_since_check: u32,
    max_bytes: u64,
    generations: u32,
    check_every: u32,
}

impl LogState {
    const fn production() -> Self {
        Self {
            file: None,
            tracked_len: 0,
            writes_since_check: 0,
            max_bytes: MAX_LOG_BYTES,
            generations: GENERATIONS,
            check_every: CHECK_EVERY_WRITES,
        }
    }

    fn append(&mut self, dir: &Path, line: &str) {
        let _ = fs::create_dir_all(dir);
        if self.file.is_none() {
            self.open(dir);
        }
        let bytes = line.as_bytes();
        if let Some(file) = self.file.as_mut() {
            let _ = file.write_all(bytes);
            let _ = file.flush();
        }
        self.tracked_len = self.tracked_len.saturating_add(bytes.len() as u64);
        self.writes_since_check = self.writes_since_check.saturating_add(1);
        if self.writes_since_check >= self.check_every && self.tracked_len >= self.max_bytes {
            self.rotate(dir);
        }
    }

    /// Open the live file. If it is already at the limit, archive it first
    /// so the bytes we are about to write land in a fresh file.
    fn open(&mut self, dir: &Path) {
        let path = dir.join(LOG_NAME);
        let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if len >= self.max_bytes {
            self.archive_current(dir);
            self.tracked_len = 0;
            self.writes_since_check = 0;
        } else {
            self.tracked_len = len;
        }
        self.file = OpenOptions::new().create(true).append(true).open(path).ok();
    }

    fn rotate(&mut self, dir: &Path) {
        self.file.take();
        self.archive_current(dir);
        self.tracked_len = 0;
        self.writes_since_check = 0;
        let path = dir.join(LOG_NAME);
        self.file = OpenOptions::new().create(true).append(true).open(path).ok();
    }

    fn archive_current(&self, dir: &Path) {
        shift_generations(dir, self.generations);
        let current = dir.join(LOG_NAME);
        let len = fs::metadata(&current).map(|m| m.len()).unwrap_or(0);
        if len == 0 {
            return;
        }
        let dest = dir.join(format!("{LOG_NAME}.1"));
        // A file that grew under the counter is only a little past the
        // limit; keep it whole. A file that arrived already huge (an old
        // unbounded log) would otherwise pin tens of MB in `.1` forever.
        if len > self.max_bytes.saturating_mul(2) {
            let _ = copy_tail(&current, &dest, self.max_bytes);
            let _ = fs::remove_file(&current);
        } else {
            let _ = fs::rename(&current, &dest);
        }
    }
}

fn shift_generations(dir: &Path, generations: u32) {
    if generations == 0 {
        return;
    }
    let _ = fs::remove_file(dir.join(format!("{LOG_NAME}.{generations}")));
    for generation in (1..generations).rev() {
        let from = dir.join(format!("{LOG_NAME}.{generation}"));
        let to = dir.join(format!("{LOG_NAME}.{}", generation + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
}

fn copy_tail(src: &Path, dest: &Path, max_bytes: u64) -> io::Result<()> {
    let mut input = File::open(src)?;
    let len = input.metadata()?.len();
    if len > max_bytes {
        input.seek(SeekFrom::End(-(max_bytes as i64)))?;
    }
    let mut output = File::create(dest)?;
    io::copy(&mut input, &mut output)?;
    Ok(())
}

static WRITER: Mutex<LogState> = Mutex::new(LogState::production());

fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = chrono::DateTime::from_timestamp(now as i64, 0)
        .unwrap_or_default()
        .with_timezone(&chrono::Local);
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn truncate_msg(msg: &str) -> Cow<'_, str> {
    if msg.len() <= MAX_MSG_BYTES {
        return Cow::Borrowed(msg);
    }
    let mut end = MAX_MSG_BYTES.saturating_sub(TRUNCATED_SUFFIX.len());
    while end > 0 && !msg.is_char_boundary(end) {
        end -= 1;
    }
    Cow::Owned(format!("{}{TRUNCATED_SUFFIX}", &msg[..end]))
}

fn format_line(tag: &str, msg: &str) -> String {
    format!("{} [{}] {}\n", timestamp(), tag, truncate_msg(msg))
}

/// Append a line to the log file and mirror to stderr.
pub fn write(tag: &str, msg: &str) {
    let line = format_line(tag, msg);
    eprint!("{line}");
    let Some(dir) = log_dir() else {
        return;
    };
    let mut guard = WRITER.lock().unwrap_or_else(|err| err.into_inner());
    guard.append(&dir, &line);
}

/// Tauri command: frontend-originated log line.
#[tauri::command]
pub fn debug_log(tag: String, msg: String) {
    write(&format!("JS:{tag}"), &msg);
}

/// Tauri command: return the log file path so the UI can link to it.
#[tauri::command]
pub fn get_log_path() -> Option<String> {
    log_file_path().and_then(|p| p.to_str().map(|s| s.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klaudio-log-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct TempLog(PathBuf);
    impl Drop for TempLog {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn small_state() -> LogState {
        LogState {
            file: None,
            tracked_len: 0,
            writes_since_check: 0,
            max_bytes: 4096,
            generations: GENERATIONS,
            check_every: 1,
        }
    }

    fn len_of(dir: &Path, name: &str) -> u64 {
        fs::metadata(dir.join(name)).map(|m| m.len()).unwrap_or(0)
    }

    #[test]
    fn rotates_past_the_limit_and_keeps_three_generations() {
        let dir = TempLog(temp_dir());
        let mut state = small_state();
        let line = format!("{}\n", "a".repeat(200));
        // 200-byte lines and a 4096-byte limit: 21 lines cross it once, and
        // 90 lines cross it four times — enough to fill `.1`–`.3` and drop
        // what would have been `.4`.
        for _ in 0..90 {
            state.append(&dir.0, &line);
        }

        assert!(dir.0.join(LOG_NAME).is_file());
        assert!(dir.0.join(format!("{LOG_NAME}.1")).is_file());
        assert!(dir.0.join(format!("{LOG_NAME}.2")).is_file());
        assert!(dir.0.join(format!("{LOG_NAME}.3")).is_file());
        assert!(!dir.0.join(format!("{LOG_NAME}.4")).exists());

        let slack = state.max_bytes + line.len() as u64;
        for name in [
            LOG_NAME,
            &format!("{LOG_NAME}.1"),
            &format!("{LOG_NAME}.2"),
            &format!("{LOG_NAME}.3"),
        ] {
            let len = len_of(&dir.0, name);
            assert!(len > 0, "{name} should hold a generation");
            assert!(len <= slack, "{name} is {len} bytes, limit is {slack}");
        }
    }

    #[test]
    fn preexisting_oversized_log_rotates_on_the_first_write() {
        let dir = TempLog(temp_dir());
        let path = dir.0.join(LOG_NAME);
        fs::write(&path, vec![b'x'; 100_000]).unwrap();

        let mut state = small_state();
        state.append(&dir.0, "hello\n");

        let archived = len_of(&dir.0, &format!("{LOG_NAME}.1"));
        assert!(archived > 0, "the oversized file should have been archived");
        assert!(
            archived <= state.max_bytes,
            "archived tail is {archived}, cap is {}",
            state.max_bytes
        );
        let current = fs::read_to_string(&path).unwrap();
        assert!(current.contains("hello"));
        assert!(current.len() < 1000);
        assert!(!current.contains(&"x".repeat(1000)));
    }

    #[test]
    fn a_single_line_is_capped_at_16kb() {
        let huge = "b".repeat(20_000);
        let line = format_line("window.error", &huge);
        assert!(line.contains("[truncated]"));
        assert!(!line.contains(&huge));
        assert!(line.len() <= MAX_MSG_BYTES + 64);
        let short = format_line("window.error", "ok");
        assert!(short.contains("ok"));
        assert!(!short.contains("[truncated]"));
    }
}
