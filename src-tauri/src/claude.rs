use std::process::Stdio;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct ClaudeState {
    pub current: Arc<Mutex<Option<Child>>>,
}

async fn kill_current(state: &ClaudeState) {
    let mut guard = state.current.lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.kill().await;
    }
}

#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    project_path: String,
    prompt: String,
    model: String,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<ClaudeState>();
    kill_current(&state).await;

    let bin = crate::binary::find_claude_binary()?;

    // Claude Code needs an interactive-ish shell to pick up auth context
    // installed via `claude login`. -p + stream-json is non-interactive output.
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt,
        "--model".into(),
        model,
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];
    if let Some(id) = resume_session_id {
        args.push("--resume".into());
        args.push(id);
    }

    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .current_dir(&project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        // kill_on_drop so accidental state loss still terminates the child.
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "claude stderr unavailable".to_string())?;

    // Reader task for stdout — one event per JSONL line.
    // session_id is present on EVERY event (not just system/init), so we
    // capture from the first line that carries it.
    let app_out = app.clone();
    tokio::spawn(async move {
        let mut session_id: Option<String> = None;
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if session_id.is_none() {
                        if let Ok(v) = serde_json::from_str::<Value>(&line) {
                            if let Some(id) = v.get("session_id").and_then(|i| i.as_str()) {
                                session_id = Some(id.to_string());
                                let _ = app_out.emit("claude:session", id);
                            }
                        }
                    }

                    let channel = match &session_id {
                        Some(id) => format!("claude:event:{id}"),
                        None => "claude:event:pending".to_string(),
                    };
                    let _ = app_out.emit(&channel, &line);
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = app_out.emit("claude:stderr", format!("reader error: {e}"));
                    break;
                }
            }
        }
        let _ = app_out.emit("claude:done", ());
    });

    // Reader task for stderr — surfaced but not terminal-critical.
    let app_err = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("claude:stderr", &line);
        }
    });

    *state.current.lock().await = Some(child);
    Ok(())
}

#[tauri::command]
pub async fn claude_cancel(state: State<'_, ClaudeState>) -> Result<(), String> {
    kill_current(&state).await;
    Ok(())
}
