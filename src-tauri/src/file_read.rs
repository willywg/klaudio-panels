use std::fs::Metadata;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;

use crate::git::{is_binary_bytes, BINARY_PROBE_BYTES};

pub(crate) const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

/// base64 inflates by 4/3 on the way to a `data:` URL, so this is roughly
/// the practical ceiling for something the webview will happily hold.
const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
pub struct ImagePayload {
    pub path: String,
    /// Derived from the file's magic bytes, never from its name.
    pub mime: String,
    /// base64 of the raw file, for a `data:` URL.
    pub data: String,
    pub bytes: u64,
}

/// Extensions we're willing to read from anywhere on disk. Everything else
/// keeps going through `read_file_bytes`, which stays pinned to the project
/// root.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg",
];

/// Identify an image by its leading bytes. The name is a hint, not evidence:
/// returning a content-derived MIME means a `.png` that is really a script
/// can't talk the webview into interpreting it as something else.
fn sniff_mime(data: &[u8], ext: &str) -> Option<&'static str> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if data.starts_with(PNG) {
        return Some("image/png");
    }
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if data.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if data.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    // RIFF containers: bytes 8..12 name the form ("WEBP").
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // ISO-BMFF: `....ftyp<brand>`; AVIF brands start with "avi".
    if data.len() >= 12 && &data[4..8] == b"ftyp" && data[8..11].starts_with(b"avi") {
        return Some("image/avif");
    }
    // SVG is text, so there are no magic bytes — probe the head for a root
    // element instead, and only when the name claims SVG.
    if ext == "svg" {
        let head = &data[..data.len().min(512)];
        let text = String::from_utf8_lossy(head);
        let trimmed = text.trim_start();
        if trimmed.starts_with("<?xml") || trimmed.starts_with("<svg") {
            return Some("image/svg+xml");
        }
    }
    None
}

/// Expand a leading `~` so the frontend never has to know the home dir.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(path)
}

/// Read an image from anywhere on disk for display.
///
/// Deliberately not routed through `resolve_rel`: Claude routinely writes
/// screenshots under a *different* project than the one that's open, and
/// project-scoping this command means the feature doesn't work for the case
/// that motivated it (#73). The boundary is drawn around the file type
/// instead — allowlisted extension, magic bytes that agree with it, a size
/// cap, and read-only. `read_file_bytes` keeps its project-root restriction
/// untouched for everything else.
#[tauri::command]
pub fn read_image(path: String) -> Result<ImagePayload, String> {
    let expanded = expand_tilde(&path);
    let abs = expanded
        .canonicalize()
        .map_err(|e| format!("resolve image: {e}"))?;

    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("not an image extension: {ext}"));
    }

    let meta = std::fs::metadata(&abs).map_err(|e| format!("stat: {e}"))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let bytes = meta.len();
    if bytes > MAX_IMAGE_BYTES {
        return Err(format!("image larger than {} MiB", MAX_IMAGE_BYTES / 1048576));
    }

    let data = std::fs::read(&abs).map_err(|e| format!("read: {e}"))?;
    let mime = sniff_mime(&data, &ext)
        .ok_or_else(|| "file contents are not a recognised image".to_string())?;

    Ok(ImagePayload {
        path: abs.to_string_lossy().into_owned(),
        mime: mime.to_string(),
        data: BASE64.encode(&data),
        bytes,
    })
}

/// Cap on returned candidates. More than a couple already means the path was
/// ambiguous enough that guessing is the wrong answer.
const MAX_PATH_MATCHES: usize = 10;

/// Ceiling on the fallback walk. A project big enough to blow past this is one
/// where a suffix guess would be unreliable anyway.
const MAX_WALK_ENTRIES: usize = 20_000;

/// True when `rel_path` ends with `needle` on a path-segment boundary.
///
/// The boundary is the whole point: `tests/foo.py` must match
/// `ai-service/tests/foo.py` but never `pkg/mytests/foo.py`, which a plain
/// `ends_with` would happily accept.
fn ends_with_segments(rel_path: &str, needle: &str) -> bool {
    if rel_path == needle {
        return true;
    }
    rel_path.len() > needle.len()
        && rel_path.ends_with(needle)
        && rel_path.as_bytes()[rel_path.len() - needle.len() - 1] == b'/'
}

/// Resolve a path printed in the terminal to something that actually exists in
/// the project, ranked best-first.
///
/// Claude prints paths relative to *its own* working directory. When a session
/// runs in a sub-project (`construct-ai/ai-service`), `tests/foo.py` is correct
/// for Claude and wrong for us — the prefix is simply missing. Rather than
/// fail, look for a file whose project-relative path ends with what we were
/// given.
///
/// Images come through here too. They used to have their own resolver keyed on
/// a bare filename, which meant a path *with* a directory was joined onto the
/// project root unchecked — the very assumption this command exists to undo,
/// so images kept the bug after source files were fixed (#83). A bare name is
/// just a suffix with one segment, so one resolver covers both.
///
/// The direct hit is checked first and costs a single `stat`, so the walk only
/// happens when there is no alternative. It uses the `ignore` crate, which
/// skips gitignored trees and `.git`, keeping it far cheaper than a naive
/// `find` — and in-process, so no shell spawn.
///
/// Returns project-relative, forward-slash paths. Empty means no candidate.
#[tauri::command]
pub fn resolve_project_file(project_path: String, rel: String) -> Result<Vec<String>, String> {
    let root = Path::new(&project_path);
    if !root.is_dir() {
        return Err("project path is not a directory".into());
    }
    // An absolute or `~/` path already says where it lives; stripping the
    // leading slash and hunting for a suffix match inside the project could
    // only ever answer a question nobody asked. The frontend short-circuits
    // these before calling; this is the second lock on the same door.
    if rel.starts_with('/') || rel.starts_with("~/") {
        return Err("expected a project-relative path".into());
    }
    let needle = rel.trim_start_matches("./");
    if needle.is_empty() {
        return Err("empty path".into());
    }
    // A traversal segment means the caller is not naming a project file; the
    // suffix search would be meaningless and `resolve_rel` would reject it.
    if needle.split('/').any(|c| c == "..") {
        return Err("path escapes project root".into());
    }

    if root.join(needle).is_file() {
        return Ok(vec![needle.to_string()]);
    }

    // Parallel walk: on a real monorepo the single-threaded version took
    // ~230ms, which is a visible hitch on a click. The visitor only pushes
    // matches, so contention on the mutex is negligible.
    let matches = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = std::sync::atomic::AtomicUsize::new(0);
    let root_owned = root.to_path_buf();

    ignore::WalkBuilder::new(root)
        .filter_entry(|e| e.file_name() != ".git")
        .build_parallel()
        .run(|| {
            let matches = std::sync::Arc::clone(&matches);
            let root = root_owned.clone();
            let needle = needle.to_string();
            let seen = &seen;
            Box::new(move |entry| {
                use ignore::WalkState;
                if seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed) > MAX_WALK_ENTRIES {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let Ok(r) = entry.path().strip_prefix(&root) else {
                    return WalkState::Continue;
                };
                let r = r
                    .components()
                    .filter_map(|c| match c {
                        std::path::Component::Normal(s) => Some(s.to_string_lossy()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("/");
                if ends_with_segments(&r, &needle) {
                    if let Ok(mut m) = matches.lock() {
                        m.push(r);
                    }
                }
                WalkState::Continue
            })
        });

    let mut out = match std::sync::Arc::try_unwrap(matches) {
        Ok(m) => m.into_inner().unwrap_or_default(),
        Err(arc) => arc.lock().map(|m| m.clone()).unwrap_or_default(),
    };
    out.sort_by_key(|p| (p.matches('/').count(), p.len()));
    out.truncate(MAX_PATH_MATCHES);
    Ok(out)
}

#[derive(Debug, Serialize, Clone)]
pub struct FilePayload {
    pub path: String,
    pub contents: Option<String>,
    pub is_binary: bool,
    pub too_large: bool,
    pub bytes: u64,
    pub mtime_ms: i64,
}

pub(crate) fn mtime_ms(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve a path we are being asked to **read**.
///
/// A project-relative path keeps the root check, so `../../.ssh/id_rsa` is
/// still refused: a relative path that climbs out is a path someone got wrong
/// (or is probing with), never one the user pointed at.
///
/// An absolute or `~/` path is taken at face value. Claude routinely hands the
/// user files that cannot be expressed relative to the open project — its own
/// scratchpad under `/private/tmp/claude-…`, a temp export, a file in a
/// sibling repo — and refusing to *display* one is the app declining to show
/// what the user just asked for and can already `cat` in the terminal below.
/// This is the same boundary `read_image` has drawn since #73, now applied to
/// text: read-only, size-capped, and only ever for a path the user pointed at.
///
/// Writes deliberately do **not** get this treatment — `write_file_bytes`
/// stays on `resolve_rel`. Klaudio never writing outside a project you opened
/// is a property worth keeping, and it costs the user nothing: an outside file
/// still opens in their own editor through "Open in…".
pub(crate) fn resolve_readable(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    if rel.starts_with('/') || rel.starts_with("~/") {
        return expand_tilde(rel)
            .canonicalize()
            .map_err(|e| format!("canonicalize file: {e}"));
    }
    resolve_rel(project_path, rel)
}

pub(crate) fn resolve_rel(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let base = Path::new(project_path);
    let candidate = base.join(rel);
    let canon_base = base
        .canonicalize()
        .map_err(|e| format!("canonicalize project: {e}"))?;
    let canon = candidate
        .canonicalize()
        .map_err(|e| format!("canonicalize file: {e}"))?;
    if !canon.starts_with(&canon_base) {
        return Err("path escapes project root".into());
    }
    Ok(canon)
}

#[tauri::command]
pub fn read_file_bytes(project_path: String, rel_path: String) -> Result<FilePayload, String> {
    let abs = resolve_readable(&project_path, &rel_path)?;
    let meta = std::fs::metadata(&abs).map_err(|e| format!("stat: {e}"))?;
    let bytes = meta.len();
    let mtime = mtime_ms(&meta);

    if bytes > MAX_PREVIEW_BYTES {
        return Ok(FilePayload {
            path: rel_path,
            contents: None,
            is_binary: false,
            too_large: true,
            bytes,
            mtime_ms: mtime,
        });
    }

    let data = std::fs::read(&abs).map_err(|e| format!("read: {e}"))?;

    let probe_len = data.len().min(BINARY_PROBE_BYTES);
    if is_binary_bytes(&data[..probe_len]) {
        return Ok(FilePayload {
            path: rel_path,
            contents: None,
            is_binary: true,
            too_large: false,
            bytes,
            mtime_ms: mtime,
        });
    }

    // Strict UTF-8: lossy decoding would inject U+FFFD which the editor
    // would happily save back, corrupting the file. Treat non-UTF-8 like
    // binary so the menu surfaces the same disabled tooltip.
    match std::str::from_utf8(&data) {
        Ok(s) => Ok(FilePayload {
            path: rel_path,
            contents: Some(s.to_owned()),
            is_binary: false,
            too_large: false,
            bytes,
            mtime_ms: mtime,
        }),
        Err(_) => Ok(FilePayload {
            path: rel_path,
            contents: None,
            is_binary: true,
            too_large: false,
            bytes,
            mtime_ms: mtime,
        }),
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "klaudio-image-test-{label}-{}-{nanos}",
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

    const PNG_HEADER: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    #[test]
    fn reads_a_real_png_and_derives_its_mime() {
        let tmp = TempDir::new("png");
        let file = tmp.path().join("shot.png");
        let mut bytes = PNG_HEADER.to_vec();
        bytes.extend_from_slice(b"trailing pixel data");
        fs::write(&file, &bytes).unwrap();

        let out = read_image(file.to_string_lossy().into_owned()).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!(out.bytes, bytes.len() as u64);
        assert_eq!(BASE64.decode(out.data).unwrap(), bytes);
    }

    #[test]
    fn refuses_a_non_image_extension() {
        let tmp = TempDir::new("txt");
        let file = tmp.path().join("notes.txt");
        fs::write(&file, b"hello").unwrap();

        let err = read_image(file.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("not an image extension"), "got {err}");
    }

    #[test]
    fn refuses_a_png_that_is_not_a_png() {
        // The extension is a hint, not evidence. A script wearing a .png
        // name must not talk its way into a data: URL.
        let tmp = TempDir::new("liar");
        let file = tmp.path().join("payload.png");
        fs::write(&file, b"#!/bin/sh\necho pwned\n").unwrap();

        let err = read_image(file.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("not a recognised image"), "got {err}");
    }

    #[test]
    fn accepts_svg_by_its_root_element() {
        let tmp = TempDir::new("svg");
        let file = tmp.path().join("icon.svg");
        fs::write(&file, b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").unwrap();

        let out = read_image(file.to_string_lossy().into_owned()).unwrap();
        assert_eq!(out.mime, "image/svg+xml");
    }

    #[test]
    fn refuses_an_svg_that_is_not_markup() {
        let tmp = TempDir::new("fake-svg");
        let file = tmp.path().join("icon.svg");
        fs::write(&file, b"just some text").unwrap();

        assert!(read_image(file.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn refuses_a_directory() {
        let tmp = TempDir::new("dir");
        let dir = tmp.path().join("shots.png");
        fs::create_dir_all(&dir).unwrap();

        assert!(read_image(dir.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn expands_a_leading_tilde() {
        let home = dirs::home_dir().expect("no home dir");
        assert_eq!(expand_tilde("~/x/y.png"), home.join("x/y.png"));
        // Only a leading `~/` counts — a literal path keeps its shape.
        assert_eq!(expand_tilde("/tmp/a~b.png"), PathBuf::from("/tmp/a~b.png"));
    }

    /// Build `<root>/<rel>` including parents, with `body` as contents.
    fn touch(root: &Path, rel: &str, body: &str) {
        let abs = root.join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(abs, body).unwrap();
    }

    #[test]
    fn a_correct_path_resolves_without_walking() {
        let tmp = TempDir::new("resolve-direct");
        touch(tmp.path(), "src/main.rs", "fn main() {}");
        let got =
            resolve_project_file(tmp.path().display().to_string(), "src/main.rs".into()).unwrap();
        assert_eq!(got, vec!["src/main.rs".to_string()]);
    }

    #[test]
    fn a_path_missing_its_subproject_prefix_is_found() {
        // The reported case: Claude runs in `ai-service` and prints
        // `tests/foo.py`, which is wrong relative to the project root.
        let tmp = TempDir::new("resolve-prefix");
        touch(tmp.path(), "ai-service/tests/test_llm_client_timeout.py", "x");
        let got = resolve_project_file(
            tmp.path().display().to_string(),
            "tests/test_llm_client_timeout.py".into(),
        )
        .unwrap();
        assert_eq!(
            got,
            vec!["ai-service/tests/test_llm_client_timeout.py".to_string()]
        );
    }

    #[test]
    fn the_suffix_must_land_on_a_segment_boundary() {
        // `pkg/mytests/foo.py` ends with the string `tests/foo.py` but is a
        // different file; a plain ends_with would wrongly return it.
        let tmp = TempDir::new("resolve-boundary");
        touch(tmp.path(), "pkg/mytests/foo.py", "x");
        let got =
            resolve_project_file(tmp.path().display().to_string(), "tests/foo.py".into()).unwrap();
        assert!(got.is_empty(), "got {got:?}");
    }

    #[test]
    fn a_leading_dot_slash_is_tolerated() {
        let tmp = TempDir::new("resolve-dotslash");
        touch(tmp.path(), "src/main.rs", "x");
        let got =
            resolve_project_file(tmp.path().display().to_string(), "./src/main.rs".into()).unwrap();
        assert_eq!(got, vec!["src/main.rs".to_string()]);
    }

    #[test]
    fn ambiguous_matches_come_back_shallowest_first() {
        let tmp = TempDir::new("resolve-ambiguous");
        touch(tmp.path(), "deep/nested/pkg/tests/conftest.py", "x");
        touch(tmp.path(), "svc/tests/conftest.py", "x");
        let got = resolve_project_file(
            tmp.path().display().to_string(),
            "tests/conftest.py".into(),
        )
        .unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], "svc/tests/conftest.py");
    }

    #[test]
    fn a_bare_filename_is_found_anywhere_in_the_project() {
        // What `resolve_project_image` used to do on its own. Images now go
        // through this resolver too, which is the point: one ranking, one set
        // of caps, no chance of the two drifting apart again (#83).
        let tmp = TempDir::new("resolve-bare");
        touch(tmp.path(), "app/assets/images/deep/logo.png", "x");
        touch(tmp.path(), "public/images/logo.png", "x");
        let got =
            resolve_project_file(tmp.path().display().to_string(), "logo.png".into()).unwrap();
        assert_eq!(got.len(), 2);
        // Shallowest first — a bare name is a guess, so guess the likelier one.
        assert_eq!(got[0], "public/images/logo.png");
    }

    #[test]
    fn a_missing_file_yields_no_candidates_rather_than_an_error() {
        // The caller falls back to the original path so the preview can show
        // its own "not found" instead of a resolver error.
        let tmp = TempDir::new("resolve-missing");
        touch(tmp.path(), "src/main.rs", "x");
        let got =
            resolve_project_file(tmp.path().display().to_string(), "nope/gone.rs".into()).unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn traversal_is_refused() {
        let tmp = TempDir::new("resolve-traversal");
        touch(tmp.path(), "src/main.rs", "x");
        assert!(
            resolve_project_file(
                tmp.path().display().to_string(),
                "../../etc/passwd".into()
            )
            .is_err()
        );
    }

    #[test]
    fn an_absolute_path_is_not_something_to_search_for() {
        // It already says where it lives. The read path takes it at face
        // value instead — see `resolve_readable`.
        let tmp = TempDir::new("resolve-absolute");
        touch(tmp.path(), "notes.md", "x");
        assert!(
            resolve_project_file(tmp.path().display().to_string(), "/tmp/notes.md".into()).is_err()
        );
        assert!(
            resolve_project_file(tmp.path().display().to_string(), "~/notes.md".into()).is_err()
        );
    }

    #[test]
    fn an_absolute_path_reads_from_outside_the_project() {
        // Claude's scratchpad, a temp export, a sibling repo — none of these
        // can be named relative to the open project, and refusing to show one
        // is the app declining to display what the user just asked for (#85).
        let outside = TempDir::new("outside");
        fs::write(outside.path().join("scratch.md"), "# hola").unwrap();
        let project = TempDir::new("project");
        touch(project.path(), "src/main.rs", "x");

        let got = read_file_bytes(
            project.path().display().to_string(),
            outside.path().join("scratch.md").display().to_string(),
        )
        .expect("outside file should read");
        assert_eq!(got.contents.as_deref(), Some("# hola"));
    }

    #[test]
    fn a_relative_path_still_cannot_climb_out() {
        // The guard that matters: a *relative* path escaping the root is one
        // someone got wrong or is probing with, never one the user pointed at.
        let outside = TempDir::new("outside-rel");
        fs::write(outside.path().join("secret.txt"), "s3cret").unwrap();
        let project = TempDir::new("project-rel");
        touch(project.path(), "src/main.rs", "x");

        let escape = format!(
            "../{}/secret.txt",
            outside.path().file_name().unwrap().to_string_lossy()
        );
        let err = read_file_bytes(project.path().display().to_string(), escape).unwrap_err();
        assert!(err.contains("escapes project root"), "got {err}");
    }

    #[test]
    fn gitignored_trees_are_not_searched() {
        // Without this the fallback would happily resolve into node_modules
        // and open a vendored copy instead of the user's file.
        let tmp = TempDir::new("resolve-ignored");
        // `ignore` only honours `.gitignore` inside a git repo, so the marker
        // directory is the precondition, not decoration. Matches how
        // `list_files_recursive` and `resolve_project_image` already behave.
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".gitignore"), "node_modules/\n").unwrap();
        touch(tmp.path(), "node_modules/dep/tests/foo.py", "x");
        let got =
            resolve_project_file(tmp.path().display().to_string(), "tests/foo.py".into()).unwrap();
        assert!(got.is_empty(), "got {got:?}");
    }

    #[test]
    fn segment_boundary_helper_edges() {
        assert!(ends_with_segments("a/b/c.py", "b/c.py"));
        assert!(ends_with_segments("a/b/c.py", "a/b/c.py"));
        assert!(ends_with_segments("a/b/c.py", "c.py"));
        assert!(!ends_with_segments("a/mytests/c.py", "tests/c.py"));
        assert!(!ends_with_segments("c.py", "a/c.py"));
    }

}
