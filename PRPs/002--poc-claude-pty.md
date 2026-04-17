# PRP 002: PoC — Claude Code embebido en PTY

> **Version:** 1.0
> **Created:** 2026-04-16
> **Status:** Ready
> **Phase:** Sprint 01 (post-pivot). Supersedes PRP 001.

---

## Goal

Reemplazar el approach stream-json del Sprint 00 por un PTY que corre `claude` interactivo. Al final del sprint, al hacer click en "+ Nueva sesión" o en una sesión de la sidebar, el usuario ve el TUI real de Claude Code (colores, slash commands, permisos interactivos, autocomplete) dentro de la ventana Tauri via xterm.js, sin ninguna reimplementación de la UI.

## Why

- **Obtiene Claude Code completo gratis.** Slash commands, `-r` picker, permission prompts, autocomplete, hooks — todo funciona sin escribir una línea de UI.
- **Cero parsing frágil.** Si Claude Code cambia su output, nuestra app no se rompe — xterm.js solo pinta bytes.
- **Alinea con OpenCode Desktop.** Mismo paradigma (ventana nativa + CLI embebido).
- **Desbloquea el resto de PROJECT.md.** File tree / diff viewer (Sprints 2-3) son paneles **alrededor** del terminal, no dentro de él.

## What

Single-PTY per window. Spawn interactivo de `claude` con env del login shell. xterm.js renderiza, resize cablea, keybinds Cmd+C/V/K configurados, cambio de sesión kills+respawns.

### Success Criteria
- [ ] `bun tauri dev` abre ventana sin warnings.
- [ ] "+ Nueva sesión" → veo TUI de `claude` nativo (greeting + `> _`).
- [ ] Escribo "lista archivos" → Claude responde con colores y formato completos.
- [ ] Ctrl+C interrumpe turno; Cmd+C copia selección; Cmd+V pega; Cmd+K limpia.
- [ ] Redimensiono ventana → TUI se acomoda.
- [ ] Click en sesión previa → PTY actual muere, nuevo `claude --resume <id>` muestra historial real.
- [ ] `ps aux | grep claude` no deja zombies tras cerrar ventana.
- [ ] `cargo check` + `cargo clippy -- -D warnings` + `bun run typecheck` limpios.

---

## All Needed Context

### Project-level
```yaml
- file: PROJECT.md
  why: Blueprint con pivot a PTY reflejado
- file: CLAUDE.md
  why: Reglas no-negociables del pivot
- file: docs/sprint-01-claude-in-pty.md
  why: Scope detallado, 9-step acceptance, riesgos y mitigaciones
- file: docs/sprint-00-stream-json-exploration.md
  why: Contexto del approach descartado (lo que sobrevive y por qué)
```

### Referencias de OpenCode (primarias ahora)
```yaml
- file: ~/proyectos/open-source/opencode/packages/desktop/src-tauri/src/cli.rs
  why: Port de probe_shell_env + load_shell_env + merge_shell_env (shell env hydration)
  lines: 220-365
  critical: |
    - Usa `env -0` (null-delimited) para parseo robusto
    - Timeout 5s en el probe; si falla, fallback de `-il` a `-l`
    - Skip nushell (no soporta el pattern)
    - Mergea con overrides; overrides ganan

- file: ~/proyectos/open-source/opencode/packages/app/src/components/terminal.tsx
  why: Patrón de integración xterm-like con resize, addons, theming
  critical: Usan ghostty-web; el shape transfiere a xterm.js pero los APIs difieren

- file: ~/proyectos/open-source/opencode/packages/app/src/context/terminal.tsx
  why: Lifecycle de PTY, cleanup, persistencia de state
```

### Referencias externas
```yaml
- url: https://github.com/wez/wezterm/tree/main/pty
  why: Docs de portable-pty (PtyPair, CommandBuilder, read/write APIs)
  critical: |
    - MasterPty::try_clone_reader() para leer desde otro thread
    - MasterPty::take_writer() para escribir
    - read es BLOCKING → usar tokio::task::spawn_blocking
    - resize via master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })

- url: https://xtermjs.org/docs/api/terminal/classes/terminal/
  why: API de xterm.js (write, onData, onResize, attachCustomKeyEventHandler)
  critical: |
    - term.write() acepta string o Uint8Array
    - term.onData callback recibe string (ya decodificado)
    - Para bytes crudos del PTY: decode server-side O pasar Uint8Array
    - Usar @xterm/addon-fit para resize al contenedor

- url: https://v2.tauri.app/develop/calling-frontend/
  why: emit / listen patterns para bytes
  critical: payload serializable; bytes como base64 o Vec<u8>
```

### Current state (branch sprint-01-pty, tras Sprint 00)
```
src-tauri/src/
├── binary.rs      # KEEP — detección de claude
├── sessions.rs    # KEEP pero remover list_session_entries
├── claude.rs      # DELETE
├── lib.rs         # EDIT — unregister claude_*, register pty_*
└── main.rs        # KEEP

src/
├── App.tsx                      # REWRITE — mount TerminalView
├── context/claude.tsx           # DELETE
├── components/chat-view.tsx     # DELETE
├── components/project-picker.tsx # KEEP
├── components/sessions-list.tsx  # KEEP (onSelect semantics change)
└── lib/claude-events.ts         # DELETE
```

### Desired state
```
src-tauri/src/
├── binary.rs
├── sessions.rs       # list_sessions_for_project only
├── shell_env.rs      # probe/load/merge shell env (new, from OpenCode)
├── pty.rs            # portable-pty lifecycle (new)
├── lib.rs            # register pty_open/write/resize/kill
└── main.rs

src/
├── App.tsx                        # terminal-centered layout
├── context/terminal.tsx           # PTY id + write/resize/kill
├── components/
│   ├── project-picker.tsx
│   ├── sessions-list.tsx
│   └── terminal-view.tsx         # xterm.js mount (new)
└── lib/
    └── bytes.ts                   # base64 helpers (new, tiny)
```

### Known gotchas & rules

```
FROM CLAUDE.md (NON-NEGOTIABLE):
- claude runs interactive. NO -p, NO --output-format.
- Never parse PTY output. Only render into xterm.js.
- Shell env hydration is MANDATORY (nvm/volta/asdf PATH).
- TERM=xterm-256color always.
- current_dir on every spawn = project_path.
- Sessions storage stays in ~/.claude/projects/ (read-only).
- Single PTY per window in Sprint 01.

PORTABLE-PTY QUIRKS:
- open_pty returns PtyPair { master, slave }. Slave goes to the child via
  CommandBuilder::spawn; master stays in the parent.
- master.take_writer() consumes — clone first if you need multiple writers.
- master.try_clone_reader() is OK; read() blocks.
- Resize: master.resize(PtySize) — also affects the child.
- No equivalent to kill_on_drop; must explicitly kill child on exit.

TAURI V2 + EVENT PAYLOAD:
- emit<T>(event, payload) where T: Serialize.
- For binary data, use base64 (simpler than byte arrays in JSON).
- listen<string>() at frontend, then atob() to get bytes.
- capabilities/default.json must include "core:event:default" (already there).

SOLIDJS + XTERM.JS:
- Mount xterm AFTER the container div is in DOM. Use onMount, not createRoot.
- Dispose Terminal + addons in onCleanup.
- ResizeObserver → debounced fitAddon.fit() → auto-triggers term.onResize.
- createEffect on activeSessionId to kill + reopen the PTY.

MACOS AUTH & SIGNING (PoC):
- bun tauri dev doesn't require signing.
- If spawn fails with "Operation not permitted" → terminal.app / Tauri dev
  needs Full Disk Access OR the user must have already run `claude` once
  so PATH is pre-hydrated; shell_env.rs handles this.
```

---

## Implementation Blueprint

### Data types

```rust
// src-tauri/src/pty.rs
pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub abort: tokio::task::AbortHandle,
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}
```

```typescript
// src/context/terminal.tsx
type TerminalStore = {
  id: string | null;
  status: "idle" | "running" | "exited";
  exitCode: number | null;
};
```

### Tasks (orden)

```yaml
T1 — Limpiar Sprint 00:
  - DELETE src-tauri/src/claude.rs
  - DELETE src/context/claude.tsx
  - DELETE src/components/chat-view.tsx
  - DELETE src/lib/claude-events.ts
  - EDIT src-tauri/src/sessions.rs: remove list_session_entries
  - EDIT src-tauri/src/lib.rs: remove `mod claude;`, remove claude_send/cancel
    from invoke_handler, remove list_session_entries
  - EDIT src/App.tsx: temporary stub that renders an empty right pane
    until T7 wires TerminalView
  - VERIFY: cargo check + bun run typecheck clean

T2 — Deps:
  - cd src-tauri && cargo add portable-pty
  - cd .. && bun add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
  - VERIFY: cargo check + bun tauri dev starts

T3 — shell_env.rs:
  - PORT from OpenCode packages/desktop/src-tauri/src/cli.rs L220-365
  - Functions: probe_shell_env, load_shell_env, merge_shell_env, is_nushell
  - Keep tests for parse_shell_env and merge_shell_env
  - Unit test: a probe against current $SHELL returns a non-empty map

T4 — pty.rs:
  - Build CommandBuilder::new(claude_bin) with args
  - cmd.cwd(project_path)
  - env = merge(load_shell_env(shell), [("TERM", "xterm-256color")])
  - native_pty_system().openpty(PtySize { rows: 24, cols: 80, ... })
  - pair.slave.spawn_command(cmd) → child
  - writer = pair.master.take_writer()
  - reader = pair.master.try_clone_reader()
  - spawn_blocking loop: reader.read(&mut [0u8; 4096]) → mpsc::Sender<Vec<u8>>
  - tokio::spawn consumes mpsc, emit!("pty:data:{id}", base64(chunk))
  - On child.wait() → emit!("pty:exit:{id}", code)
  - Store session in PtyState.sessions

T5 — context/terminal.tsx:
  - createStore TerminalStore
  - async open(project_path, args) → invoke("pty_open") → setStore id
  - write(bytes: Uint8Array) → invoke("pty_write", { id, b64: btoa(...) })
  - resize(cols, rows) → invoke("pty_resize")
  - kill() → invoke("pty_kill")
  - listen("pty:data:...") dynamic based on current id (createEffect)
  - listen("pty:exit:...") → setStore status "exited"

T6 — components/terminal-view.tsx:
  - ref <div>; onMount:
    * const term = new Terminal({ theme, fontFamily: monoFont, ... })
    * term.loadAddon(fitAddon); term.loadAddon(webLinksAddon)
    * term.open(ref)
    * fitAddon.fit()
    * term.onData(data => ctx.write(new TextEncoder().encode(data)))
    * term.onResize(({cols, rows}) => ctx.resize(cols, rows))
    * ResizeObserver on container → debounced fitAddon.fit()
    * attachCustomKeyEventHandler: handle Cmd+C/V/K
    * Subscribe to pty:data:{id} and write to term
  - onCleanup: term.dispose(), ctx.kill()
  - createEffect on ctx.id changes → if null, term.clear()

T7 — App.tsx wiring:
  - Replace ChatView mount with TerminalView
  - onNew handler: await term.kill(); await term.open(projectPath, [])
  - onSelect(id): await term.kill(); await term.open(projectPath, ["--resume", id])
  - handleChangeProject: await term.kill(); reset state
  - Guard: don't spawn second PTY while status === "running"

T8 — Validación:
  - Execute 9-step flow
  - Write docs/sprint-01-results.md
  - Tag v0.1.0-pty after merge
```

### Pseudocódigo clave

```rust
// src-tauri/src/pty.rs
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;
use base64::{engine::general_purpose::STANDARD, Engine as _};

#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    project_path: String,
    args: Vec<String>,
) -> Result<String, String> {
    let bin = crate::binary::find_claude_binary()?;
    let shell = crate::shell_env::get_user_shell();
    let shell_env = crate::shell_env::load_shell_env(&shell);
    let env = crate::shell_env::merge_shell_env(
        shell_env,
        vec![("TERM".into(), "xterm-256color".into())],
    );

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(bin);
    for a in &args { cmd.arg(a); }
    cmd.cwd(project_path);
    for (k, v) in env { cmd.env(k, v); }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);  // must drop so the master sees EOF when child exits

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);

    // Blocking read loop
    let tx_blocking = tx.clone();
    let read_handle = tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx_blocking.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Async emitter
    let app2 = app.clone();
    let id2 = id.clone();
    let emit_handle = tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let b64 = STANDARD.encode(&chunk);
            let _ = app2.emit(&format!("pty:data:{id2}"), b64);
        }
    });

    // Child waiter — emit exit
    let app3 = app.clone();
    let id3 = id.clone();
    let mut child_waiter = child; // move into task
    tokio::task::spawn_blocking(move || {
        let status = child_waiter.wait().ok();
        let code = status.and_then(|s| s.exit_code().try_into().ok()).unwrap_or(-1i32);
        let _ = app3.emit(&format!("pty:exit:{id3}"), code);
    });

    state.sessions.lock().unwrap().insert(
        id.clone(),
        PtySession { writer, master: pair.master, abort: emit_handle.abort_handle() },
    );

    Ok(id)
}
```

> **Nota:** el pseudocódigo arriba tiene un problema — `child` se mueve a dos tasks (waiter + storage). La implementación real guarda el child en `PtySession` y lo `wait()`ea al hacer `pty_kill`. O, alternativa: no guardar el child y depender del EOF del reader para emitir exit. Resolver en T4.

```typescript
// src/components/terminal-view.tsx
import { onCleanup, onMount, createEffect } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useTerminal } from "@/context/terminal";

export function TerminalView() {
  const ctx = useTerminal();
  let containerRef: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let unlistens: UnlistenFn[] = [];

  onMount(() => {
    term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', monospace",
      fontSize: 13,
      theme: { background: "#0b0b0c", foreground: "#e5e5e5" },
      cursorBlink: true,
      allowProposedApi: true,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef!);
    fit.fit();

    term.onData((data) => {
      ctx.write(new TextEncoder().encode(data));
    });
    term.onResize(({ cols, rows }) => ctx.resize(cols, rows));

    term.attachCustomKeyEventHandler((e) => {
      const meta = e.metaKey || e.ctrlKey && navigator.platform.startsWith("Mac") === false;
      if (e.metaKey && e.key === "c") return term!.hasSelection(); // let browser copy
      if (e.metaKey && e.key === "v") return true; // let browser paste (onData catches it)
      if (e.metaKey && e.key === "k") { term!.clear(); return false; }
      return true;
    });

    const ro = new ResizeObserver(debounce(() => fit!.fit(), 50));
    ro.observe(containerRef!);

    onCleanup(() => {
      ro.disconnect();
      for (const un of unlistens) un();
      term?.dispose();
      void ctx.kill();
    });
  });

  // Subscribe to pty:data:<id>
  createEffect(() => {
    const id = ctx.store.id;
    if (!id) return;
    let detach: UnlistenFn | undefined;
    let cancelled = false;
    listen<string>(`pty:data:${id}`, (e) => {
      const bytes = Uint8Array.from(atob(e.payload), (c) => c.charCodeAt(0));
      term?.write(bytes);
    }).then((fn) => { if (cancelled) fn(); else detach = fn; });
    onCleanup(() => { cancelled = true; detach?.(); });
  });

  return <div ref={containerRef} class="h-full w-full" />;
}

function debounce<F extends (...a: any[]) => any>(fn: F, ms: number) {
  let t: number | undefined;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms) as unknown as number;
  }) as F;
}
```

---

## Validation Loop

### Level 1: Syntax & style
```bash
bun run typecheck
cd src-tauri && cargo check && cargo clippy -- -D warnings
```

### Level 2: Smoke tests (Rust probes)
Crear un `bin/probe-shell-env.rs` que imprima `PATH` hidratado y verifique que incluye nvm/homebrew.

### Level 3: Integración manual — 9 pasos de `sprint-01-claude-in-pty.md`

```bash
bun tauri dev
```

Ejecutar flujo completo. Si algo falla, anotar en `docs/sprint-01-results.md`.

---

## Final Checklist

- [ ] Código del Sprint 00 eliminado (claude.rs, chat-view, context/claude, claude-events)
- [ ] `portable-pty`, `@xterm/xterm` y addons instalados
- [ ] `shell_env.rs` porta `probe_shell_env` y verifica contra el shell del user
- [ ] `pty.rs` expone 4 comandos + 2 eventos; child terminations emit code
- [ ] `context/terminal.tsx` conecta eventos a createEffect con cleanup
- [ ] `terminal-view.tsx` monta xterm, resize + keybinds funcionan
- [ ] `App.tsx` mata + respawnea al cambiar sesión/proyecto
- [ ] 9 pasos del sprint pasan
- [ ] cargo check + clippy + typecheck limpios
- [ ] `docs/sprint-01-results.md` firmado
- [ ] Merge a `main` + tag `v0.1.0-pty`

---

## Anti-Patterns to Avoid

- ❌ Usar `-p`/`--output-format` — eso es el approach abandonado
- ❌ Parsear stdout del PTY en Rust para "detectar" algo
- ❌ Omitir shell env hydration (falla silenciosa de nvm)
- ❌ Sin `TERM=xterm-256color` (sin colores)
- ❌ `term.onData` directo a `invoke` sin batching (10+ invokes por key press)
- ❌ Olvidar `drop(pair.slave)` tras spawn (master no recibe EOF al exit)
- ❌ Guardar child + wait en sitios distintos (ownership conflict)
- ❌ Fit por cada ResizeObserver event sin debounce (jitter de UI)
- ❌ Multi-PTY en Sprint 01 (fuera de scope)
- ❌ Persistir buffer entre reloads (fuera de scope; PTY muere con la ventana)

---

## Notes

- **Confidence: 7/10.** Shell env hydration + portable-pty lifecycle son las dos áreas con más probabilidad de sorpresas. Todo lo demás es cablear APIs conocidas.
- **Branch:** `sprint-01-pty`. Al validar, merge a `main`.
- **Tiempo estimado:** 2–4 días efectivos.
