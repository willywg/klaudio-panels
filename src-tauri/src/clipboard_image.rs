use tauri::AppHandle;

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
    let now = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
    let file_path = temp_dir.join(format!("image_{now}.png"));

    if let Some(buf) = image::RgbaImage::from_raw(width, height, rgba.to_vec()) {
        buf.save(&file_path).map_err(|e| e.to_string())?;
        Ok(Some(file_path.to_string_lossy().into_owned()))
    } else {
        Ok(None)
    }
}
