use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

pub struct PtySession {
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;
const READ_CHUNK: usize = 4096;

/// Core PTY spawn routine used by both Claude and embedded editor sessions.
/// `binary` is the absolute path of the executable to run; `env` is the
/// fully-merged env (shell-hydrated + overrides) the child should inherit.
/// `initial_cols` / `initial_rows` let the caller spawn with xterm's already-
/// fitted dimensions so TUIs (nvim, helix) don't render a first paint at the
/// 80x24 default and then have to reflow.
#[allow(clippy::too_many_arguments)]
fn spawn_pty(
    app: AppHandle,
    state: &PtyState,
    id: String,
    binary: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    initial_cols: Option<u16>,
    initial_rows: Option<u16>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: initial_rows.unwrap_or(INITIAL_ROWS),
            cols: initial_cols.unwrap_or(INITIAL_COLS),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(binary);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    for (k, v) in env {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    // Must drop the slave so the master sees EOF when the child exits.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {e}"))?;

    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);

    let tx_blocking = tx.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx_blocking.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let app_data = app.clone();
    let id_data = id.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let b64 = STANDARD.encode(&chunk);
            let _ = app_data.emit(&format!("pty:data:{id_data}"), b64);
        }
    });

    let app_exit = app.clone();
    let id_exit = id.clone();
    tokio::task::spawn_blocking(move || {
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        let _ = app_exit.emit(&format!("pty:exit:{id_exit}"), code);
    });

    let session = PtySession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
    };

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);

    Ok(())
}

#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    project_path: String,
    args: Vec<String>,
) -> Result<(), String> {
    let bin = crate::binary::find_claude_binary()?;
    let shell = crate::shell_env::get_user_shell();
    let shell_env = crate::shell_env::load_shell_env(&shell);
    let env = crate::shell_env::merge_shell_env(
        shell_env,
        vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("CLAUDE_DESKTOP".into(), "1".into()),
        ],
    );
    let bin_str = bin
        .to_str()
        .ok_or_else(|| "claude binary path is not valid UTF-8".to_string())?
        .to_string();
    spawn_pty(app, &state, id, bin_str, args, project_path, env, None, None)
}

/// Spawn an embedded terminal editor (nvim / helix / vim / micro) inside a
/// PTY. The `binary` is resolved against the hydrated login-shell PATH so
/// Homebrew / nvm / asdf installs are found even though the GUI process
/// inherits the stripped macOS launchd PATH.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open_editor(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    project_path: String,
    binary: String,
    args: Vec<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), String> {
    let shell = crate::shell_env::get_user_shell();
    let shell_env = crate::shell_env::load_shell_env(&shell);
    let resolved = crate::shell_env::which_in_shell(shell_env.as_ref(), &binary)
        .ok_or_else(|| format!("binary not found on PATH: {binary}"))?;
    let env = crate::shell_env::merge_shell_env(
        shell_env,
        vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("CLAUDE_DESKTOP".into(), "1".into()),
        ],
    );
    spawn_pty(app, &state, id, resolved, args, project_path, env, cols, rows)
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, PtyState>,
    id: String,
    b64: String,
) -> Result<(), String> {
    let bytes = STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("invalid base64: {e}"))?;

    let writer = {
        let guard = state.sessions.lock().map_err(|e| e.to_string())?;
        guard
            .get(&id)
            .map(|s| s.writer.clone())
            .ok_or_else(|| format!("pty {id} not found"))?
    };

    let mut w = writer.lock().map_err(|e| e.to_string())?;
    w.write_all(&bytes).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let master = {
        let guard = state.sessions.lock().map_err(|e| e.to_string())?;
        guard
            .get(&id)
            .map(|s| s.master.clone())
            .ok_or_else(|| format!("pty {id} not found"))?
    };

    let m = master.lock().map_err(|e| e.to_string())?;
    m.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let removed = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);

    if let Some(session) = removed {
        // Drop the master — this closes the PTY file descriptor, the child
        // receives SIGHUP, and our read loop sees EOF.
        drop(session.writer);
        drop(session.master);
    }
    Ok(())
}
