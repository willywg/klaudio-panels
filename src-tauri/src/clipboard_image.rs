#[cfg(target_os = "windows")]
use std::path::Path;
#[cfg(target_os = "windows")]
use std::time::{Duration, SystemTime};
use tauri::AppHandle;

/// Prune temporary clipboard PNGs older than `max_age`. Best-effort cleanup so
/// sensitive screenshots do not accumulate in `$TMPDIR/klaudio-clipboard/`.
#[cfg(target_os = "windows")]
fn prune_old_files(dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let expired = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|mtime| now.duration_since(mtime).ok())
            .is_some_and(|age| age >= max_age);
        if expired {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Remove any leftover clipboard images from previous sessions on boot.
#[cfg(target_os = "windows")]
pub fn cleanup_temp_dir() {
    let temp_dir = std::env::temp_dir().join("klaudio-clipboard");
    prune_old_files(&temp_dir, Duration::ZERO);
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn paste_clipboard_image(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let clipboard = app.clipboard();
    let img = match clipboard.read_image() {
        Ok(img) => img,
        Err(_) => return Ok(None),
    };
    let width = img.width();
    let height = img.height();
    let rgba = img.rgba();
    if width == 0 || height == 0 || rgba.is_empty() {
        return Ok(None);
    }

    let temp_dir = std::env::temp_dir().join("klaudio-clipboard");
    let _ = std::fs::create_dir_all(&temp_dir);
    prune_old_files(&temp_dir, Duration::from_secs(15 * 60));

    let now = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
    let file_path = temp_dir.join(format!("image_{now}.png"));

    if let Some(buf) = image::RgbaImage::from_raw(width, height, rgba.to_vec()) {
        buf.save(&file_path).map_err(|e| e.to_string())?;
        Ok(Some(file_path.to_string_lossy().into_owned()))
    } else {
        Ok(None)
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn paste_clipboard_image(_app: AppHandle) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn prune_old_files_removes_expired_pngs_and_keeps_fresh_ones() {
        let dir = std::env::temp_dir().join(format!("klaudio-clip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let png = dir.join("image_test.png");
        let txt = dir.join("notes.txt");
        std::fs::write(&png, b"png").unwrap();
        std::fs::write(&txt, b"txt").unwrap();

        prune_old_files(&dir, Duration::from_secs(3600));
        assert!(png.exists(), "fresh png should be kept");

        prune_old_files(&dir, Duration::ZERO);
        assert!(!png.exists(), "expired png should be removed");
        assert!(txt.exists(), "non-png files should be untouched");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
