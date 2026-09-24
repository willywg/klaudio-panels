use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use crate::debug_log;

pub struct PtySession {
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// The spawned child itself, so `pty_kill` can force-terminate it
    /// directly rather than relying solely on dropping `master`/`writer` to
    /// deliver a SIGHUP the child might not treat as fatal (see
    /// `pty_kill`'s doc comment).
    pub child: Arc<Mutex<Box<dyn Child + Send>>>,
    /// Shared with the reader thread. `pty_pause` blocks the next `read`;
    /// `pty_kill` and child exit both wake it (see `PauseGate`).
    pause: Arc<PauseGate>,
    /// Set for agent tabs. Shell and editor PTYs leave this empty, so a
    /// Cursor hook event cannot be routed to them.
    pub(crate) agent: Option<crate::agent::AgentId>,
    pub(crate) project_path: String,
    pub(crate) session_id: Option<String>,
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;
const READ_CHUNK: usize = 4096;
/// Emitter batches whatever is already queued, and anything else that
/// arrives within this window, up to [`COALESCE_MAX`]. Fewer `pty:data`
/// events means less base64 and less JSON on the way into the webview
/// (#113 point 3). Raw `ipc::Channel` bytes (no base64, no JSON) are still
/// open on that issue — this only coalesces the existing event.
const COALESCE_MAX: usize = 64 * 1024;
const COALESCE_WAIT: std::time::Duration = std::time::Duration::from_millis(3);

/// One PTY reader's pause flag. The reader calls `wait_until_readable`
/// before every `read`. While it waits it does not consume the master, so
/// the kernel PTY buffer fills and the child blocks in `write` — that is
/// the backpressure xterm's flow control is asking for. The agent waits
/// instead of the webview queueing until xterm discards the data.
///
/// `stop` (`pty_kill` / drop) and `child_exited` both wake a waiter. `stop`
/// makes the reader leave without another `read`. Child exit clears the
/// pause and ignores later pauses, so the reader can drain what is already
/// buffered and observe EOF instead of staying parked on a dead session.
struct PauseGate {
    inner: Mutex<PauseInner>,
    cv: Condvar,
}

struct PauseInner {
    paused: bool,
    stop: bool,
    exited: bool,
}

impl PauseGate {
    fn new() -> Self {
        Self {
            inner: Mutex::new(PauseInner {
                paused: false,
                stop: false,
                exited: false,
            }),
            cv: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, PauseInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pause(&self) {
        let mut guard = self.lock();
        if guard.stop || guard.exited {
            return;
        }
        guard.paused = true;
    }

    fn resume(&self) {
        let mut guard = self.lock();
        if guard.stop {
            return;
        }
        guard.paused = false;
        self.cv.notify_all();
    }

    /// `pty_kill` and dropping the session. The reader must leave even if
    /// it is inside `wait_until_readable`; the caller also drops the master
    /// so a `read` already in progress unblocks.
    fn stop(&self) {
        let mut guard = self.lock();
        guard.stop = true;
        guard.paused = false;
        self.cv.notify_all();
    }

    /// The child has exited. Unpause and refuse further pauses so the
    /// reader reaches EOF. A later `stop` still wins.
    fn child_exited(&self) {
        let mut guard = self.lock();
        guard.exited = true;
        guard.paused = false;
        self.cv.notify_all();
    }

    /// `true` when the caller may `read`. `false` means `stop` was set and
    /// the reader should exit.
    fn wait_until_readable(&self) -> bool {
        let mut guard = self.lock();
        while guard.paused && !guard.stop && !guard.exited {
            guard = self.cv.wait(guard).unwrap_or_else(|e| e.into_inner());
        }
        !guard.stop
    }
}

#[derive(Debug)]
enum PtyRead {
    Data(usize),
    Eof,
    Stopped,
}

/// One iteration of the PTY reader. The pause check is *before* `read`: a
/// paused reader holds no master bytes, which is what fills the kernel
/// buffer and blocks the child.
fn read_pty_chunk(reader: &mut dyn Read, gate: &PauseGate, buf: &mut [u8]) -> PtyRead {
    if !gate.wait_until_readable() {
        return PtyRead::Stopped;
    }
    match reader.read(buf) {
        Ok(0) => PtyRead::Eof,
        Ok(n) => PtyRead::Data(n),
        Err(_) => PtyRead::Eof,
    }
}

/// Pull one payload for `pty:data`. Starts with `pending` (a chunk the
/// previous call held back to stay under `limit`) or the next read, then
/// appends chunks already in the channel and any that arrive before `wait`
/// elapses. Byte order is the read order. The caller feeds the result to
/// the OSC 777 sniffer, so a frame split across reads is still assembled.
async fn recv_coalesced(
    rx: &mut mpsc::Receiver<Vec<u8>>,
    pending: &mut Option<Vec<u8>>,
    limit: usize,
    wait: std::time::Duration,
) -> Option<Vec<u8>> {
    let mut acc = match pending.take() {
        Some(chunk) => chunk,
        None => rx.recv().await?,
    };
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        if acc.len() >= limit {
            break;
        }
        match rx.try_recv() {
            Ok(chunk) => {
                if acc.len() + chunk.len() > limit {
                    *pending = Some(chunk);
                    break;
                }
                acc.extend(chunk);
            }
            Err(mpsc::error::TryRecvError::Empty) => {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                if left.is_zero() {
                    break;
                }
                tokio::select! {
                    biased;
                    next = rx.recv() => {
                        match next {
                            Some(chunk) => {
                                if acc.len() + chunk.len() > limit {
                                    *pending = Some(chunk);
                                    break;
                                }
                                acc.extend(chunk);
                            }
                            None => break,
                        }
                    }
                    _ = tokio::time::sleep(left) => break,
                }
            }
            Err(mpsc::error::TryRecvError::Disconnected) => break,
        }
    }
    Some(acc)
}

/// Sanitize the first bytes emitted by a PTY child for logging. ANSI escape
/// sequences and control bytes become visible markers so the log stays
/// useful when opened in TextEdit/Console.app.
fn log_startup_bytes(id: &str, bytes: &[u8]) {
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes.iter().take(512) {
        match b {
            0x1B => out.push_str("<ESC>"),
            0x07 => out.push_str("<BEL>"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x20..=0x7E => out.push(b as char),
            _ => out.push_str(&format!("<{b:02x}>")),
        }
    }
    debug_log::write("pty", &format!("id={id} first_bytes={out}"));
}

/// Put Klaudio's `pbcopy` shim ahead of `/usr/bin` on the child's `PATH` and
/// tell it where to report. This is the single choke point every Klaudio
/// terminal passes through — Claude tabs, the shell panel and editor PTYs
/// alike — which is why the injection lives here rather than in each
/// `pty_open*`.
///
/// Applied *after* direnv, so a project's `.envrc` cannot displace the shim.
/// Leaves the env untouched when the cache dir is unavailable: no shim simply
/// means no clipboard history, never a broken `PATH`.
///
/// Also left untouched when another Klaudio owns the socket. The shim would
/// happily report to it, and the clip would surface in *that* window's panel —
/// copied here, listed somewhere else. Withholding `KLAUDIO_CLIP_SOCK` makes
/// the shim fall through to the real `pbcopy` instead (#96).
fn clipboard_history_env(env: Vec<(String, String)>) -> Vec<(String, String)> {
    if !crate::clipboard_history::shim_active() {
        return env;
    }
    let (Some(dir), Some(sock)) = (
        crate::clipboard_history::shim_dir(),
        crate::clipboard_history::socket_path(),
    ) else {
        return env;
    };
    let dir = dir.display().to_string();
    let mut out: Vec<(String, String)> = env
        .into_iter()
        .map(|(k, v)| {
            if k == "PATH" {
                (k, format!("{dir}:{v}"))
            } else {
                (k, v)
            }
        })
        .collect();
    if !out.iter().any(|(k, _)| k == "PATH") {
        out.push(("PATH".into(), dir));
    }
    out.push(("KLAUDIO_CLIP_SOCK".into(), sock.display().to_string()));
    out
}

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
    agent: Option<crate::agent::AgentId>,
    session_id: Option<String>,
) -> Result<(), String> {
    // Ids are minted by the frontend (crypto.randomUUID), so a collision is
    // always a caller bug — and a costly one: `sessions.insert` would replace
    // the entry, orphaning the previous child (nothing kills it) while its
    // reader thread keeps emitting on the SAME `pty:data:<id>` channel. Two
    // nvim processes interleaving bytes into one xterm is exactly the garbled
    // editor reported in #68. Refuse instead.
    if state
        .sessions
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .contains_key(&id)
    {
        debug_log::write("pty", &format!("id={id} refused: id already in use"));
        return Err(format!("pty id already in use: {id}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: initial_rows.unwrap_or(INITIAL_ROWS),
            cols: initial_cols.unwrap_or(INITIAL_COLS),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&binary);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    // `CommandBuilder::new` pre-populates its env from Klaudio's own
    // process env. Clear it so the child gets exactly `env` (the fully
    // resolved shell + direnv env) — otherwise a variable direnv removed
    // could still leak in if Klaudio's own process happened to carry it.
    // Safe to clear unconditionally: every caller builds `env` from
    // `shell_env::cached_shell_env`, which always returns a real env (the
    // hydrated shell env, or — when that probe fails, e.g. nushell or a
    // timeout — a sanitized fallback with `CLAUDE_CONFIG_DIR` stripped and
    // `PATH`/`HOME` intact), never an empty map.
    cmd.env_clear();
    for (k, v) in clipboard_history_env(env) {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        let err = format!("spawn failed: {e}");
        debug_log::write(
            "pty",
            &format!("id={id} spawn failed binary={binary:?} err={e}"),
        );
        err
    })?;
    // Must drop the slave so the master sees EOF when the child exits.
    drop(pair.slave);

    debug_log::write(
        "pty",
        &format!(
            "id={id} spawned binary={binary:?} args={args:?} cwd={cwd:?} cols={} rows={}",
            initial_cols.unwrap_or(INITIAL_COLS),
            initial_rows.unwrap_or(INITIAL_ROWS)
        ),
    );

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {e}"))?;

    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);

    let pause = Arc::new(PauseGate::new());
    let tx_blocking = tx.clone();
    let id_read = id.clone();
    let bytes_seen = Arc::new(AtomicUsize::new(0));
    let bytes_seen_clone = bytes_seen.clone();
    let pause_reader = Arc::clone(&pause);
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; READ_CHUNK];
        let mut logged_startup = false;
        let mut startup_buf: Vec<u8> = Vec::with_capacity(512);
        loop {
            match read_pty_chunk(&mut reader, &pause_reader, &mut buf) {
                PtyRead::Stopped | PtyRead::Eof => break,
                PtyRead::Data(n) => {
                    bytes_seen_clone.fetch_add(n, Ordering::Relaxed);
                    if !logged_startup {
                        startup_buf.extend_from_slice(&buf[..n.min(512 - startup_buf.len())]);
                        if startup_buf.len() >= 256 {
                            log_startup_bytes(&id_read, &startup_buf);
                            logged_startup = true;
                        }
                    }
                    if tx_blocking.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
        if !logged_startup && !startup_buf.is_empty() {
            log_startup_bytes(&id_read, &startup_buf);
        }
    });

    let app_data = app.clone();
    let id_data = id.clone();
    tokio::spawn(async move {
        let mut sniffer = crate::cli_agent::Osc777Sniffer::new();
        let mut pending: Option<Vec<u8>> = None;
        // Coalesce before the sniffer, not after: `feed` still sees every
        // byte, in order, including a frame that was split across reads.
        while let Some(chunk) =
            recv_coalesced(&mut rx, &mut pending, COALESCE_MAX, COALESCE_WAIT).await
        {
            for event in sniffer.feed(&chunk) {
                let _ = app_data.emit("claude:event", &event);
            }
            let b64 = STANDARD.encode(&chunk);
            let _ = app_data.emit(&format!("pty:data:{id_data}"), b64);
        }
    });

    // Shared with `pty_kill` (via `PtySession::child` below) so a kill
    // request can reach the child directly instead of only being able to
    // drop `master`/`writer` and hope the OS's SIGHUP delivery is fatal to
    // it. Polled with `try_wait` rather than a blocking `wait()`
    // specifically so this task never holds the lock for the child's
    // entire lifetime — `pty_kill` must always be able to acquire it
    // promptly to call `kill`.
    let child: Arc<Mutex<Box<dyn Child + Send>>> = Arc::new(Mutex::new(child));

    let app_exit = app.clone();
    let id_exit = id.clone();
    let bytes_seen_exit = bytes_seen.clone();
    let child_wait = Arc::clone(&child);
    let pause_exit = Arc::clone(&pause);
    tokio::task::spawn_blocking(move || {
        const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
        let code = loop {
            let mut guard = match child_wait.lock() {
                Ok(guard) => guard,
                Err(_) => break -1,
            };
            match guard.try_wait() {
                Ok(Some(status)) => break status.exit_code() as i32,
                Ok(None) => {
                    drop(guard);
                    std::thread::sleep(POLL_INTERVAL);
                }
                Err(_) => break -1,
            }
        };
        // Wake a reader that was paused when the child died, and ignore any
        // pause that arrives while the last bytes drain. Otherwise the
        // thread would sit in the condvar forever and `pty:exit` would be
        // the only sign the session ended.
        pause_exit.child_exited();
        debug_log::write(
            "pty",
            &format!(
                "id={id_exit} exited code={code} bytes_read={}",
                bytes_seen_exit.load(Ordering::Relaxed)
            ),
        );
        let _ = app_exit.emit(&format!("pty:exit:{id_exit}"), code);
    });

    let session = PtySession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child,
        pause,
        agent,
        project_path: cwd.clone(),
        session_id,
    };

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);

    Ok(())
}

/// Spawn an agent in a PTY. `session_id` is what decides how it starts: a
/// session to resume, or `None` for a fresh one. The argv itself is the
/// registry's business (`agent::argv`) — no caller needs to know that Claude
/// spells resume `--resume`, and a caller that built the argv could disagree
/// with the session id the tab was created with.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    project_path: String,
    agent_id: String,
    session_id: Option<String>,
    expected_profile_id: String,
) -> Result<(), String> {
    let agent_id = crate::agent::AgentId::parse(&agent_id)?;
    let spec = crate::agent::spec(agent_id);
    // Disabling an agent hides it everywhere in the UI; this is the backstop
    // for a tab that was already in flight, or restored from a workspace
    // remembered while it was still on.
    if !crate::agent_settings::load(agent_id).enabled {
        return Err(format!(
            "{} is disabled in the agent settings.",
            spec.display_name
        ));
    }
    let bin = crate::binary::find_agent_binary(agent_id)?;
    let shell_env = crate::shell_env::cached_shell_env().clone();

    let mut extra_env: Vec<(String, String)> = vec![
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
        ("CLAUDE_DESKTOP".into(), "1".into()),
    ];
    extra_env.extend(crate::agent::extra_env(agent_id));
    let mut env = crate::project_env::resolve_project_env(&project_path, shell_env, extra_env)?;

    // Klaudio's own launch env reaches this point through the login-shell
    // probe, which runs as a subprocess of Klaudio and re-exports whatever
    // Klaudio was started with (#104). Started from inside a Claude Code
    // session, that means the child would inherit the *launching* session's
    // markers — and `CLAUDE_CODE_CHILD_SESSION` makes `claude` stop writing
    // its transcript without saying so, which takes the Sessions list, tab
    // correlation and resume down with it. Stripped last, so nothing can
    // reintroduce one; names only in the log, never values.
    let stripped = crate::agent::strip_blocked_env(agent_id, &mut env);
    if !stripped.is_empty() {
        debug_log::write(
            "pty",
            &format!(
                "id={id} stripped {} inherited {} marker(s): {}",
                stripped.len(),
                spec.display_name,
                stripped.join(" ")
            ),
        );
    }

    // The frontend resolved `expected_profile_id` before spawning this tab
    // (see context/terminal.tsx) so it could be attached to the tab up
    // front, closing the race where a live session event could arrive
    // before the profile was known. Re-derive the profile from the *same*
    // env just resolved above (not a second direnv evaluation) and refuse
    // to spawn if the project's .envrc changed in between — never log or
    // return either id, only that they diverged. An agent with no account
    // concept of its own is always on the default profile.
    let actual_profile_id = if crate::agent::supports_profiles(agent_id) {
        let config_dir = env
            .iter()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
            .map(|(_, v)| PathBuf::from(v));
        crate::project_env::profile_id_for_config_dir(config_dir.as_deref())
    } else {
        crate::project_env::DEFAULT_PROFILE_ID.to_string()
    };
    if actual_profile_id != expected_profile_id {
        debug_log::write(
            "pty",
            &format!("id={id} refused: resolved profile no longer matches the profile checked before spawn"),
        );
        return Err(format!(
            "this project's {} profile changed since it was last checked (its .envrc may \
             have been edited) — reopen the project and try again",
            spec.display_name
        ));
    }

    let launch = match &session_id {
        Some(s) => crate::agent::Launch::Resume(s.clone()),
        None => crate::agent::Launch::New,
    };
    let args = crate::agent::argv(agent_id, &launch);

    let sock = crate::agent_hooks::socket_path().map(|p| p.display().to_string());
    crate::agent_hooks::apply_cursor_hook_env(
        agent_id == crate::agent::AgentId::Cursor,
        crate::agent_hooks::hook_active(),
        sock.as_deref(),
        &id,
        &mut env,
    );

    // cursor-agent runs each command in a login zsh, whose path_helper
    // would put /usr/bin/pbcopy ahead of the shim (#117).
    let env = crate::shell_integration::agent_env(agent_id == crate::agent::AgentId::Cursor, env);

    let bin_str = bin
        .to_str()
        .ok_or_else(|| format!("{} binary path is not valid UTF-8", spec.display_name))?
        .to_string();
    spawn_pty(
        app,
        &state,
        id,
        bin_str,
        args,
        project_path,
        env,
        None,
        None,
        Some(agent_id),
        session_id,
    )
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
    let shell_env = crate::shell_env::cached_shell_env().clone();
    let path_summary = shell_env
        .as_ref()
        .and_then(|m| m.get("PATH"))
        .cloned()
        .unwrap_or_else(|| "<missing>".into());
    debug_log::write(
        "editor",
        &format!(
            "id={id} binary={binary} shell={shell} PATH={path_summary} cols={cols:?} rows={rows:?}"
        ),
    );
    let resolved = match crate::shell_env::which_in_shell(shell_env.as_ref(), &binary) {
        Some(p) => p,
        None => {
            let err = format!("binary not found on PATH: {binary}");
            debug_log::write("editor", &format!("id={id} {err}"));
            return Err(err);
        }
    };
    debug_log::write(
        "editor",
        &format!("id={id} binary={binary} resolved={resolved}"),
    );
    let env = crate::shell_env::merge_shell_env(
        shell_env,
        vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("CLAUDE_DESKTOP".into(), "1".into()),
        ],
    );
    spawn_pty(
        app,
        &state,
        id,
        resolved,
        args,
        project_path,
        env,
        cols,
        rows,
        None,
        None,
    )
}

/// Spawn the user's login shell ($SHELL) in the project cwd. Used by the
/// bottom shell-terminal dock. Interactive login-shell (`-l -i`) so aliases,
/// nvm, starship, etc. load the same way they would in iTerm/Terminal.app.
#[tauri::command]
pub async fn pty_open_shell(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    project_path: String,
) -> Result<(), String> {
    let shell = crate::shell_env::get_user_shell();
    let shell_env = crate::shell_env::cached_shell_env().clone();
    let env = crate::shell_env::merge_shell_env(
        shell_env,
        vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("KLAUDIO_SHELL".into(), "1".into()),
        ],
    );
    // A login zsh's path_helper would put /usr/bin/pbcopy ahead of the shim
    // (#117); the wrapper puts it back after the user's startup files.
    let env = crate::shell_integration::shell_tab_env(&shell, env);
    // POSIX /bin/sh doesn't understand `-l` the same way; keep it to `-i`
    // there. Every other shell (zsh/bash/fish) accepts `-l -i`.
    let args: Vec<String> = if shell.ends_with("/sh") {
        vec!["-i".into()]
    } else {
        vec!["-l".into(), "-i".into()]
    };
    debug_log::write(
        "shell",
        &format!("id={id} shell={shell} cwd={project_path}"),
    );
    spawn_pty(
        app,
        &state,
        id,
        shell,
        args,
        project_path,
        env,
        None,
        None,
        None,
        None,
    )
}

#[tauri::command]
pub async fn pty_write(state: State<'_, PtyState>, id: String, b64: String) -> Result<(), String> {
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

fn pause_gate(state: &PtyState, id: &str) -> Option<Arc<PauseGate>> {
    state
        .sessions
        .lock()
        .ok()?
        .get(id)
        .map(|session| Arc::clone(&session.pause))
}

/// Stop this PTY's reader before its next `read`. A missing id is success:
/// the frontend resumes on close, and that races `pty_kill` removing the
/// session. While paused, the kernel PTY buffer fills and the child blocks
/// in `write` (see `PauseGate`).
#[tauri::command]
pub async fn pty_pause(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    if let Some(gate) = pause_gate(&state, &id) {
        gate.pause();
    }
    Ok(())
}

/// Let a paused reader call `read` again. Same missing-id rule as `pty_pause`.
#[tauri::command]
pub async fn pty_resume(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    if let Some(gate) = pause_gate(&state, &id) {
        gate.resume();
    }
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
        // Wake the reader first. If it is parked on the pause condvar, this
        // is the only thing that lets it exit; dropping the master below
        // unblocks a `read` that already started.
        session.pause.stop();
        // Drop the master — this closes the PTY file descriptor, the child
        // receives SIGHUP, and our read loop sees EOF.
        drop(session.writer);
        drop(session.master);

        // Not guaranteed to be enough on its own: some CLIs install their
        // own SIGHUP handler that survives a lost controlling terminal
        // (e.g. to keep background tasks running), so the child may simply
        // not exit from the hangup above. `Child::kill` (portable-pty's
        // `ChildKiller` impl for `std::process::Child`) sends SIGHUP
        // itself, waits up to ~250ms for the child to exit on its own, and
        // falls back to an unconditional SIGKILL if it's still alive —
        // that fallback is what actually makes termination happen in that
        // case. Run on a blocking thread since that grace-period wait
        // sleeps synchronously. This still does not make exit
        // *synchronous* with `pty_kill` returning — any caller that needs
        // to react to a confirmed exit must listen for the `pty:exit:<id>`
        // event `spawn_pty`'s exit-confirmation task emits, not assume this
        // call finished the job.
        //
        // Guarded by `try_wait` under the same lock: closing a tab always
        // calls `pty_kill`, including for a tab whose child already exited
        // on its own (`/exit`, Ctrl+D, a crash) and was already reaped by
        // `spawn_pty`'s exit-confirmation poll loop above. portable-pty's
        // `Child::kill` sends SIGHUP unconditionally, with no "already
        // reaped" check of its own — calling it on a reaped child would
        // signal whatever PID the OS has since recycled to a new,
        // unrelated process. Holding the lock across both calls closes
        // that race: the poll loop can't reap in between.
        let child = session.child;
        let _ = tokio::task::spawn_blocking(move || kill_if_still_alive(&child)).await;
    }
    Ok(())
}

/// Signals `child` only if `try_wait` confirms it has not already exited.
/// See `pty_kill`'s doc comment for why the check and the signal must
/// happen under the same lock. Returns whether a kill was actually
/// attempted, so tests can assert on it directly.
fn kill_if_still_alive(child: &Mutex<Box<dyn Child + Send>>) -> bool {
    match child.lock() {
        Ok(mut child) => match child.try_wait() {
            Ok(None) => {
                let _ = child.kill();
                true
            }
            _ => false,
        },
        Err(_) => false,
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn a_claude_spawn_never_gets_the_cursor_hook_env() {
        let mut env = vec![("PATH".into(), "/usr/bin".into())];
        crate::agent_hooks::apply_cursor_hook_env(
            false,
            true,
            Some("/tmp/hook.sock"),
            "pty-claude",
            &mut env,
        );
        assert!(env
            .iter()
            .all(|(k, _)| k != "KLAUDIO_HOOK_SOCK" && k != "KLAUDIO_PTY_ID"));
    }

    /// Spawns a real child (`std::process::Child`, which portable-pty's
    /// `Child`/`ChildKiller` impls target directly — see `lib.rs:271` and
    /// `:340` of the vendored `portable-pty` 0.9.0 source) and boxes it the
    /// same way `spawn_pty` boxes the PTY-slave-spawned child.
    fn spawn_boxed(mut cmd: Command) -> Box<dyn Child + Send> {
        Box::new(cmd.spawn().expect("failed to spawn test child"))
    }

    /// Reproduces William's report exactly: the child exits on its own
    /// first (standing in for `/exit`, Ctrl+D, or a crash), *then*
    /// `pty_kill`'s guarded path runs. Before the fix, `Child::kill` ran
    /// unconditionally and issued `libc::kill` at the recorded PID
    /// regardless of whether anything was still listening there — the
    /// exposure window for signalling a PID the OS has since recycled.
    /// `kill_if_still_alive` must detect the child is already reaped via
    /// `try_wait` and skip calling `kill()` altogether.
    #[test]
    fn does_not_signal_a_child_that_already_exited_on_its_own() {
        let child = spawn_boxed(Command::new("true"));
        let guarded: Mutex<Box<dyn Child + Send>> = Mutex::new(child);

        // Reap it ourselves first, exactly like `spawn_pty`'s
        // exit-confirmation poll loop would before a user gets around to
        // closing the tab.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let reaped = matches!(guarded.lock().unwrap().try_wait(), Ok(Some(_)));
            if reaped {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "test child did not exit in time"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // The PTY entry's cleanup (removing it from `PtyState`) happens in
        // `pty_kill` itself regardless of this outcome — what this guards
        // is strictly whether a signal goes out to the now-stale PID.
        assert!(
            !kill_if_still_alive(&guarded),
            "must not attempt to signal a child that already exited"
        );
    }

    /// The complementary case: a child that is genuinely still running
    /// must still be killed — the fix must not turn into "never kill
    /// anything".
    #[test]
    fn signals_and_reaps_a_child_that_is_still_alive() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let child = spawn_boxed(cmd);
        let guarded: Mutex<Box<dyn Child + Send>> = Mutex::new(child);

        assert!(
            kill_if_still_alive(&guarded),
            "must attempt to signal a child that is still running"
        );

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let reaped = matches!(guarded.lock().unwrap().try_wait(), Ok(Some(_)));
            if reaped {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "kill_if_still_alive did not actually terminate the child"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    /// A reader parked on the pause gate must leave when the session is
    /// killed, without ever calling `read` again. This is the thread-leak
    /// the close path has to close: dropping the master does not wake a
    /// condvar wait.
    #[test]
    fn stop_wakes_a_paused_reader_and_it_exits() {
        let gate = Arc::new(PauseGate::new());
        gate.pause();
        let gate_reader = Arc::clone(&gate);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = std::io::empty();
            let mut buf = [0u8; 8];
            let outcome = read_pty_chunk(&mut reader, &gate_reader, &mut buf);
            let _ = tx.send(outcome);
        });

        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            rx.try_recv().is_err(),
            "reader must still be blocked while paused"
        );
        gate.stop();
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(PtyRead::Stopped) => {}
            other => panic!("paused reader did not stop cleanly: {other:?}"),
        }
    }

    /// Child exit unpauses the reader so it can observe EOF, and a pause
    /// that arrives afterwards does not stick.
    #[test]
    fn child_exit_unblocks_a_paused_reader() {
        let gate = Arc::new(PauseGate::new());
        gate.pause();
        let gate_reader = Arc::clone(&gate);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // `empty()` returns EOF immediately, so reaching it proves the
            // waiter was released. A still-paused gate would never send.
            let mut reader = std::io::empty();
            let mut buf = [0u8; 8];
            let outcome = read_pty_chunk(&mut reader, &gate_reader, &mut buf);
            let _ = tx.send(outcome);
        });

        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(rx.try_recv().is_err(), "reader must be paused");
        gate.child_exited();
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(PtyRead::Eof) => {}
            other => panic!("reader did not drain after child exit: {other:?}"),
        }
        gate.pause();
        assert!(
            gate.wait_until_readable(),
            "a pause after child exit must not block the reader"
        );
    }

    /// `yes` writes as fast as the PTY accepts it. Pausing the reader has to
    /// stop the byte counter; resuming has to move it again; stopping a
    /// paused reader has to join the thread.
    #[test]
    fn pause_stops_a_live_pty_reader_until_resume_and_kill_joins_it() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let child = pair
            .slave
            .spawn_command(CommandBuilder::new("/usr/bin/yes"))
            .expect("spawn yes");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let master = pair.master;

        let gate = Arc::new(PauseGate::new());
        let bytes = Arc::new(AtomicUsize::new(0));
        let gate_reader = Arc::clone(&gate);
        let bytes_reader = Arc::clone(&bytes);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        // Panic-safe: a failed assertion must still kill `yes` and wake the
        // reader. This test spawned the child; nothing else should reap it.
        struct Cleanup {
            gate: Arc<PauseGate>,
            child: Option<Box<dyn Child + Send>>,
            master: Option<Box<dyn MasterPty + Send>>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.gate.stop();
                drop(self.master.take());
                if let Some(child) = self.child.take() {
                    let guarded = Mutex::new(child);
                    let _ = kill_if_still_alive(&guarded);
                }
            }
        }
        let cleanup = Cleanup {
            gate: Arc::clone(&gate),
            child: Some(child),
            master: Some(master),
        };
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_CHUNK];
            while let PtyRead::Data(n) = read_pty_chunk(&mut reader, &gate_reader, &mut buf) {
                bytes_reader.fetch_add(n, Ordering::Relaxed);
            }
            let _ = done_tx.send(());
        });

        let started = std::time::Instant::now();
        while bytes.load(Ordering::Relaxed) == 0 {
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "reader produced no output"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        gate.pause();
        // One `read` may already be inside the kernel. Let it finish, then
        // the counter must sit still — `yes` would otherwise move it by
        // megabytes in this window.
        std::thread::sleep(std::time::Duration::from_millis(80));
        let paused_at = bytes.load(Ordering::Relaxed);
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert_eq!(
            bytes.load(Ordering::Relaxed),
            paused_at,
            "paused reader kept consuming PTY bytes"
        );

        gate.resume();
        let resumed = std::time::Instant::now();
        while bytes.load(Ordering::Relaxed) <= paused_at {
            assert!(
                resumed.elapsed() < std::time::Duration::from_secs(2),
                "reader did not resume"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        drop(cleanup);
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("reader thread did not exit after stop");
    }

    fn osc_permission_frame() -> Vec<u8> {
        let json = r#"{"v":1,"agent":"claude","event":"permission_request","tool_name":"Bash"}"#;
        let mut out = b"\x1b]777;notify;warp://cli-agent;".to_vec();
        out.extend_from_slice(json.as_bytes());
        out.push(0x07);
        out
    }

    /// Replay the coalescer over captured reads. A sample joins the current
    /// payload when it arrived within `wait` of the payload's first byte and
    /// fits under `limit`. This is the model the measurement below reports;
    /// production uses [`recv_coalesced`], which follows the same rules on a
    /// live channel.
    fn coalesce_captured(
        samples: &[(std::time::Duration, Vec<u8>)],
        limit: usize,
        wait: std::time::Duration,
    ) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut index = 0;
        while index < samples.len() {
            let start = samples[index].0;
            let mut acc = samples[index].1.clone();
            index += 1;
            while index < samples.len() && acc.len() < limit {
                if samples[index].0.saturating_sub(start) > wait {
                    break;
                }
                if acc.len() + samples[index].1.len() > limit {
                    break;
                }
                acc.extend_from_slice(&samples[index].1);
                index += 1;
            }
            out.push(acc);
        }
        out
    }

    #[tokio::test]
    async fn coalescing_keeps_byte_order_and_a_split_osc777_frame() {
        let frame = osc_permission_frame();
        let mid = frame.len() / 2;
        let (tx, mut rx) = mpsc::channel(8);
        tx.send(frame[..mid].to_vec()).await.unwrap();
        tx.send(frame[mid..].to_vec()).await.unwrap();
        tx.send(b"tail".to_vec()).await.unwrap();
        drop(tx);

        let mut pending = None;
        // Limit above the frame so the split halves and the tail merge.
        let merged = recv_coalesced(
            &mut rx,
            &mut pending,
            frame.len() + 8,
            std::time::Duration::from_millis(20),
        )
        .await
        .unwrap();
        assert_eq!(merged, {
            let mut all = frame.clone();
            all.extend_from_slice(b"tail");
            all
        });
        assert!(recv_coalesced(
            &mut rx,
            &mut pending,
            64,
            std::time::Duration::from_millis(1)
        )
        .await
        .is_none());

        let mut whole = crate::cli_agent::Osc777Sniffer::new();
        let mut split = crate::cli_agent::Osc777Sniffer::new();
        let from_whole = whole.feed(&frame);
        let mut from_split = split.feed(&frame[..mid]);
        from_split.extend(split.feed(&frame[mid..]));
        let mut from_merged = crate::cli_agent::Osc777Sniffer::new();
        let merged_events = from_merged.feed(&merged);
        assert_eq!(from_whole.len(), 1);
        assert_eq!(from_split.len(), 1);
        assert_eq!(merged_events.len(), 1);
        assert_eq!(from_whole[0].event, "permission_request");
        assert_eq!(from_split[0].event, from_whole[0].event);
        assert_eq!(merged_events[0].tool_name, from_whole[0].tool_name);
    }

    #[tokio::test]
    async fn coalescing_holds_back_a_chunk_that_would_pass_the_limit() {
        let (tx, mut rx) = mpsc::channel(4);
        tx.send(vec![1; 6]).await.unwrap();
        tx.send(vec![2; 6]).await.unwrap();
        drop(tx);

        let mut pending = None;
        let first = recv_coalesced(
            &mut rx,
            &mut pending,
            8,
            std::time::Duration::from_millis(5),
        )
        .await
        .unwrap();
        assert_eq!(first, vec![1; 6]);
        let second = recv_coalesced(
            &mut rx,
            &mut pending,
            8,
            std::time::Duration::from_millis(5),
        )
        .await
        .unwrap();
        assert_eq!(second, vec![2; 6]);
    }

    /// One `pty:data` per `read` is the pre-coalesce pipe. Capture a short
    /// burst from `/usr/bin/yes` and report both that rate and the coalesced
    /// one. Asserts shape, not a machine-specific throughput.
    #[test]
    fn measure_coalesced_pty_events_against_one_event_per_read() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let child = pair
            .slave
            .spawn_command(CommandBuilder::new("/usr/bin/yes"))
            .expect("spawn yes");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let master = pair.master;
        let gate = Arc::new(PauseGate::new());

        struct Cleanup {
            child: Option<Box<dyn Child + Send>>,
            master: Option<Box<dyn MasterPty + Send>>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                drop(self.master.take());
                if let Some(child) = self.child.take() {
                    let guarded = Mutex::new(child);
                    let _ = kill_if_still_alive(&guarded);
                }
            }
        }
        let cleanup = Cleanup {
            child: Some(child),
            master: Some(master),
        };

        let started = std::time::Instant::now();
        let window = std::time::Duration::from_millis(250);
        let mut samples: Vec<(std::time::Duration, Vec<u8>)> = Vec::new();
        let mut buf = [0u8; READ_CHUNK];
        while started.elapsed() < window {
            match read_pty_chunk(&mut reader, &gate, &mut buf) {
                PtyRead::Data(n) => {
                    samples.push((started.elapsed(), buf[..n].to_vec()));
                }
                PtyRead::Eof | PtyRead::Stopped => break,
            }
        }
        drop(cleanup);

        let raw_events = samples.len();
        let raw_bytes: usize = samples.iter().map(|(_, chunk)| chunk.len()).sum();
        assert!(
            raw_events > 10,
            "expected a burst of reads, got {raw_events}"
        );
        let coalesced = coalesce_captured(&samples, COALESCE_MAX, COALESCE_WAIT);
        let coalesced_bytes: usize = coalesced.iter().map(|chunk| chunk.len()).sum();
        assert_eq!(
            coalesced_bytes, raw_bytes,
            "coalescing must not drop or reorder"
        );
        assert!(
            coalesced.len() < raw_events,
            "coalescing should cut the event count"
        );

        let secs = window.as_secs_f64();
        let raw_avg = raw_bytes / raw_events;
        let coal_avg = coalesced_bytes / coalesced.len();
        eprintln!(
            "pty:data harness ({:.0} ms of /usr/bin/yes): before {} events/s, avg {} bytes; after {} events/s, avg {} bytes ({} → {} events, {} bytes)",
            window.as_secs_f64() * 1000.0,
            (raw_events as f64 / secs) as u64,
            raw_avg,
            (coalesced.len() as f64 / secs) as u64,
            coal_avg,
            raw_events,
            coalesced.len(),
            raw_bytes,
        );
    }
}
