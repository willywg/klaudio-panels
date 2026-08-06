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

/// Most matches we'll bother reporting for a bare filename. Beyond a handful
/// the name is too ambiguous to guess from anyway.
const MAX_IMAGE_MATCHES: usize = 8;

/// Locate an image inside a project by bare filename.
///
/// Claude lists images by name alone (`logo.png`, `logo-turismoi-small.png`)
/// far more often than by full path. Joining such a name onto the project
/// root produces `<project>/logo.png`, which almost never exists — that was
/// the `No such file or directory` the user hit (#73). Searching the project
/// finds the real one.
///
/// Results are sorted shortest-path-first, so a top-level `public/images/x.png`
/// beats something buried six directories deep. Gitignored files and dotdirs
/// are skipped, which is also what keeps this cheap: no `node_modules`, no
/// build output.
#[tauri::command]
pub fn resolve_project_image(
    project_path: String,
    name: String,
) -> Result<Vec<String>, String> {
    let root = Path::new(&project_path);
    if !root.is_dir() {
        return Err("project path is not a directory".into());
    }
    // Guard against a "name" that is really a path, and against traversal.
    if name.contains('/') || name.is_empty() || name == ".." {
        return Err("expected a bare filename".into());
    }
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("not an image extension: {ext}"));
    }

    let mut out: Vec<String> = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if entry.file_name() != std::ffi::OsStr::new(&name) {
            continue;
        }
        out.push(entry.path().to_string_lossy().into_owned());
        if out.len() >= MAX_IMAGE_MATCHES * 4 {
            break;
        }
    }
    out.sort_by_key(|p| (p.matches('/').count(), p.len()));
    out.truncate(MAX_IMAGE_MATCHES);
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
    let abs = resolve_rel(&project_path, &rel_path)?;
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
    fn finds_a_bare_filename_anywhere_in_the_project() {
        let tmp = TempDir::new("resolve");
        let root = tmp.path();
        fs::create_dir_all(root.join("app/assets/images/deep")).unwrap();
        fs::create_dir_all(root.join("public/images")).unwrap();
        fs::write(root.join("public/images/logo.png"), PNG_HEADER).unwrap();
        fs::write(root.join("app/assets/images/deep/logo.png"), PNG_HEADER).unwrap();

        let hits =
            resolve_project_image(root.to_string_lossy().into_owned(), "logo.png".into()).unwrap();

        assert_eq!(hits.len(), 2);
        // Shallowest first — a bare name is a guess, so guess the likelier one.
        assert!(hits[0].ends_with("public/images/logo.png"), "got {hits:?}");
    }

    #[test]
    fn resolve_refuses_a_path_or_a_non_image() {
        let tmp = TempDir::new("resolve-guard");
        let root = tmp.path().to_string_lossy().into_owned();

        assert!(resolve_project_image(root.clone(), "../etc/passwd.png".into()).is_err());
        assert!(resolve_project_image(root.clone(), "a/b.png".into()).is_err());
        assert!(resolve_project_image(root, "notes.txt".into()).is_err());
    }

    #[test]
    fn expands_a_leading_tilde() {
        let home = dirs::home_dir().expect("no home dir");
        assert_eq!(expand_tilde("~/x/y.png"), home.join("x/y.png"));
        // Only a leading `~/` counts — a literal path keeps its shape.
        assert_eq!(expand_tilde("/tmp/a~b.png"), PathBuf::from("/tmp/a~b.png"));
    }
}
