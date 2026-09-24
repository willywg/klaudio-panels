//! Surgical edits to a Cursor `hooks.json`.
//!
//! The path is always passed in. Nothing here touches the real
//! `~/.cursor`. A file with comments, a file that does not parse, or a
//! symlink (the file or its parent directory) is refused and left
//! byte-identical: re-serializing would drop the comments, and Cursor
//! itself refuses a config path that contains a symlink.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const BACKUP_SUFFIX: &str = ".klaudio-backup";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum HookFileStatus {
    On,
    Off,
    Unmanaged { reason: String, snippet: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookEditError {
    Unmanaged { reason: String, snippet: String },
    Io(String),
}

impl std::fmt::Display for HookEditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HookEditError::Unmanaged { reason, snippet } => {
                write!(f, "{reason}\n\nAdd this entry by hand:\n{snippet}")
            }
            HookEditError::Io(e) => write!(f, "{e}"),
        }
    }
}

pub fn status(path: &Path, command: &str) -> HookFileStatus {
    match read_editable(path, command) {
        Ok(None) => HookFileStatus::Off,
        Ok(Some(doc)) => {
            if stop_commands(&doc).iter().any(|c| c == command) {
                HookFileStatus::On
            } else {
                HookFileStatus::Off
            }
        }
        Err(HookEditError::Unmanaged { reason, snippet }) => {
            HookFileStatus::Unmanaged { reason, snippet }
        }
        Err(HookEditError::Io(_)) => HookFileStatus::Unmanaged {
            reason: "could not read hooks.json".into(),
            snippet: snippet(command),
        },
    }
}

pub fn install(path: &Path, command: &str) -> Result<(), HookEditError> {
    let existing = read_editable(path, command)?;
    let mut doc = existing.unwrap_or_else(empty_doc);
    let mut stops = stop_entries(&doc);
    if stops.iter().any(|e| entry_command(e) == Some(command)) {
        return Ok(());
    }
    stops.push(serde_json::json!({ "command": command }));
    set_stops(&mut doc, stops);
    write_doc(path, &doc)
}

pub fn uninstall(path: &Path, command: &str) -> Result<(), HookEditError> {
    let Some(mut doc) = read_editable(path, command)? else {
        return Ok(());
    };
    let stops: Vec<Value> = stop_entries(&doc)
        .into_iter()
        .filter(|e| entry_command(e) != Some(command))
        .collect();
    set_stops(&mut doc, stops);
    write_doc(path, &doc)
}

pub fn snippet(command: &str) -> String {
    // The command is shell-quoted and may carry characters JSON must
    // escape; let serde do it rather than interpolating into a literal.
    serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "hooks": { "stop": [ { "command": command } ] }
    }))
    .unwrap_or_default()
}

fn empty_doc() -> Value {
    serde_json::json!({ "version": 1, "hooks": {} })
}

fn read_editable(path: &Path, command: &str) -> Result<Option<Value>, HookEditError> {
    if path_is_symlink(path) || parent_is_symlink(path) {
        return Err(unmanaged(
            "hooks.json or its directory is a symlink, which Cursor refuses to load",
            command,
        ));
    }
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(HookEditError::Io(e.to_string())),
    };
    if has_comment(&raw) {
        return Err(unmanaged(
            "hooks.json contains comments, which would be dropped if Klaudio rewrote it",
            command,
        ));
    }
    let doc = match serde_json::from_str::<Value>(&raw) {
        Ok(v) if v.is_object() => v,
        _ => return Err(unmanaged("hooks.json is not a JSON object", command)),
    };
    // A `hooks` or `stop` of the wrong shape is someone else's data we
    // cannot merge into; rewriting it would throw it away.
    match doc.get("hooks") {
        None => {}
        Some(h) if h.is_object() => {
            if h.get("stop").is_some_and(|s| !s.is_array()) {
                return Err(unmanaged("hooks.stop in hooks.json is not a list", command));
            }
        }
        Some(_) => return Err(unmanaged("hooks in hooks.json is not an object", command)),
    }
    Ok(Some(doc))
}

fn unmanaged(reason: &str, command: &str) -> HookEditError {
    HookEditError::Unmanaged {
        reason: reason.to_string(),
        snippet: snippet(command),
    }
}

fn path_is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn parent_is_symlink(path: &Path) -> bool {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .and_then(|p| fs::symlink_metadata(p).ok())
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// `//` and `/* */` outside of strings. A URL inside a command string is
/// not a comment and must not make the file unmanageable.
fn has_comment(raw: &str) -> bool {
    let b = raw.as_bytes();
    let mut i = 0;
    let mut in_str = false;
    let mut escape = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            if escape {
                escape = false;
            } else if c == b'\\' {
                escape = true;
            } else if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == b'"' {
            in_str = true;
            i += 1;
            continue;
        }
        if c == b'/' && i + 1 < b.len() && (b[i + 1] == b'/' || b[i + 1] == b'*') {
            return true;
        }
        i += 1;
    }
    false
}

fn hooks_map(doc: &Value) -> Option<&Map<String, Value>> {
    doc.get("hooks")?.as_object()
}

fn stop_entries(doc: &Value) -> Vec<Value> {
    hooks_map(doc)
        .and_then(|h| h.get("stop"))
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default()
}

fn stop_commands(doc: &Value) -> Vec<String> {
    stop_entries(doc)
        .iter()
        .filter_map(|e| entry_command(e).map(str::to_string))
        .collect()
}

fn entry_command(entry: &Value) -> Option<&str> {
    entry.get("command")?.as_str()
}

fn set_stops(doc: &mut Value, stops: Vec<Value>) {
    let obj = doc.as_object_mut().expect("doc is an object");
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    hooks
        .as_object_mut()
        .expect("hooks object")
        .insert("stop".into(), Value::Array(stops));
}

fn write_doc(path: &Path, doc: &Value) -> Result<(), HookEditError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| HookEditError::Io(e.to_string()))?;
    }
    write_backup_once(path)?;
    let body = serde_json::to_vec_pretty(doc).map_err(|e| HookEditError::Io(e.to_string()))?;
    let mode = fs::metadata(path)
        .ok()
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0o644);
    let tmp = temp_path(path);
    {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&tmp)
            .map_err(|e| HookEditError::Io(e.to_string()))?;
        f.write_all(&body)
            .map_err(|e| HookEditError::Io(e.to_string()))?;
        f.write_all(b"\n")
            .map_err(|e| HookEditError::Io(e.to_string()))?;
        f.sync_all().map_err(|e| HookEditError::Io(e.to_string()))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        HookEditError::Io(e.to_string())
    })?;
    Ok(())
}

fn write_backup_once(path: &Path) -> Result<(), HookEditError> {
    if !path.exists() {
        return Ok(());
    }
    let backup = backup_path(path);
    if backup.exists() {
        return Ok(());
    }
    fs::copy(path, &backup).map_err(|e| HookEditError::Io(e.to_string()))?;
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "hooks.json".into());
    path.with_file_name(format!("{name}{BACKUP_SUFFIX}"))
}

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "hooks.json".into());
    path.with_file_name(format!(".{name}.klaudio-tmp-{}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("klaudio-hooks-{}-{}", std::process::id(), unique()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn unique() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }

    const OURS: &str = "/tmp/klaudio-cursor-hook";

    #[test]
    fn creates_a_missing_file_with_our_entry() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        install(&path, OURS).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["hooks"]["stop"][0]["command"], OURS);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merges_into_an_existing_stop_array() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        fs::write(
            &path,
            r#"{"version":1,"hooks":{"stop":[{"command":"/bin/other"}],"sessionStart":[{"command":"/bin/keep"}]},"extra":true}"#,
        )
        .unwrap();
        install(&path, OURS).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["hooks"]["stop"][0]["command"], "/bin/other");
        assert_eq!(v["hooks"]["stop"][1]["command"], OURS);
        assert_eq!(v["hooks"]["sessionStart"][0]["command"], "/bin/keep");
        assert_eq!(v["extra"], true);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_hooks_or_stop_of_the_wrong_shape() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        for raw in [
            r#"{"version":1,"hooks":{"stop":{"command":"/bin/other"}}}"#,
            r#"{"version":1,"hooks":["nope"]}"#,
        ] {
            fs::write(&path, raw).unwrap();
            assert!(matches!(
                install(&path, OURS),
                Err(HookEditError::Unmanaged { .. })
            ));
            assert!(matches!(
                uninstall(&path, OURS),
                Err(HookEditError::Unmanaged { .. })
            ));
            assert_eq!(fs::read_to_string(&path).unwrap(), raw);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_is_idempotent() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        install(&path, OURS).unwrap();
        let once = fs::read(&path).unwrap();
        install(&path, OURS).unwrap();
        assert_eq!(fs::read(&path).unwrap(), once);
        let v: Value = serde_json::from_slice(&once).unwrap();
        assert_eq!(v["hooks"]["stop"].as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        fs::write(
            &path,
            format!(
                r#"{{"version":1,"hooks":{{"stop":[{{"command":"/bin/other"}},{{"command":"{OURS}"}}]}}}}"#
            ),
        )
        .unwrap();
        uninstall(&path, OURS).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["hooks"]["stop"].as_array().unwrap().len(), 1);
        assert_eq!(v["hooks"]["stop"][0]["command"], "/bin/other");
        uninstall(&path, "/bin/other").unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["hooks"]["stop"].as_array().unwrap().len(), 0);
        assert!(path.exists(), "uninstall must not delete the file");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_comments_invalid_json_and_a_symlink() {
        let dir = scratch();
        let path = dir.join("hooks.json");

        fs::write(
            &path,
            "{\n  // note\n  \"version\": 1,\n  \"hooks\": {}\n}\n",
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        let err = install(&path, OURS).unwrap_err();
        assert!(matches!(err, HookEditError::Unmanaged { .. }));
        assert_eq!(fs::read(&path).unwrap(), before);

        fs::write(&path, "{ not json").unwrap();
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            install(&path, OURS).unwrap_err(),
            HookEditError::Unmanaged { .. }
        ));
        assert_eq!(fs::read(&path).unwrap(), before);

        fs::remove_file(&path).unwrap();
        let real = dir.join("real.json");
        fs::write(&real, r#"{"version":1,"hooks":{}}"#).unwrap();
        std::os::unix::fs::symlink(&real, &path).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            install(&path, OURS).unwrap_err(),
            HookEditError::Unmanaged { .. }
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(path_is_symlink(&path));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_url_inside_a_string_is_not_a_comment() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        fs::write(
            &path,
            r#"{"version":1,"hooks":{"stop":[{"command":"echo https://example.com"}]}}"#,
        )
        .unwrap();
        install(&path, OURS).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["hooks"]["stop"].as_array().unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_is_written_once() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        fs::write(
            &path,
            r#"{"version":1,"hooks":{"stop":[{"command":"/bin/other"}]}}"#,
        )
        .unwrap();
        let original = fs::read(&path).unwrap();
        install(&path, OURS).unwrap();
        let backup = dir.join("hooks.json.klaudio-backup");
        assert_eq!(fs::read(&backup).unwrap(), original);
        install(&path, "/bin/second").unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        install(&path, OURS).unwrap();
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("klaudio-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_follows_the_file() {
        let dir = scratch();
        let path = dir.join("hooks.json");
        assert_eq!(status(&path, OURS), HookFileStatus::Off);
        install(&path, OURS).unwrap();
        assert_eq!(status(&path, OURS), HookFileStatus::On);
        uninstall(&path, OURS).unwrap();
        assert_eq!(status(&path, OURS), HookFileStatus::Off);
        fs::write(&path, "{ // comment\n}\n").unwrap();
        assert!(matches!(
            status(&path, OURS),
            HookFileStatus::Unmanaged { .. }
        ));
        let _ = fs::remove_dir_all(&dir);
    }
}
