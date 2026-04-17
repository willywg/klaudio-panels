# Sprint 01 — Claude Code en PTY

> **Duración objetivo:** 2–4 días efectivos
> **Branch:** `sprint-01-pty`
> **Objetivo único:** embeber `claude` corriendo interactivo dentro de la ventana Tauri, con xterm.js renderizando su TUI completo. Sidebar de sesiones funciona y permite `--resume` directo en el PTY.

## Por qué este approach

El Sprint 00 probó que stream-json funciona pero reimplementa la UI de Claude Code perdiendo features que ya existen (slash commands, permission prompts, `-r` picker, autocomplete, hooks). En vez de envolverlo, lo **embebemos**: el usuario ve el TUI real en una ventana nativa, como OpenCode Desktop hace con su CLI.

## Scope

### Dentro
1. `portable-pty` spawneando `claude` interactivo con env del login shell hidratado.
2. xterm.js renderiza todo el output tal cual (colores, cursor, mouse tracking).
3. Entrada del usuario va al PTY stdin vía `pty_write`.
4. Resize de la ventana redimensiona el PTY (`pty_resize`).
5. Sidebar de sesiones (sobrevive de Sprint 00):
   - Click en "+ Nueva sesión" → `claude` (sin flags).
   - Click en sesión existente → `claude --resume <id>`.
   - Cambiar de sesión mata el PTY anterior.
6. Cambio de proyecto mata el PTY activo.
7. Shell keybinds:
   - Ctrl+C pasa al PTY (SIGINT) — default de xterm.js.
   - Cmd+C copia selección al clipboard (no pasa al PTY).
   - Cmd+V pega desde clipboard al PTY stdin.
   - Cmd+K limpia la pantalla del terminal.

### Fuera (explícito)
- ❌ Multi-tab / multi-PTY simultáneos — Sprint 02.
- ❌ File tree, diff viewer — Sprints 02-03.
- ❌ Persistencia del buffer al reload — el PTY se cierra con la ventana.
- ❌ Rehidratar historial en UI — `claude --resume` lo hace solo.
- ❌ SQLite — `localStorage` sigue bastando.
- ❌ Theming custom — una paleta oscura hardcodeada.

## Los 9 pasos (acceptance)

```
1. bun tauri dev → ventana abre sin warnings
2. Elijo proyecto con sesiones previas (ej. construct-ai/copilot-agent)
3. Layout 2-col: sidebar con 5 sesiones + panel con terminal xterm.js vacío
4. Click "+ Nueva sesión" → veo:
   ✻ Claude Code v2.1.112
   ¿qué quieres hacer?
   > _
5. Escribo "lista archivos" → Claude responde con TUI nativo
   (colores, cajas, etc. exactamente como en Terminal.app)
6. Ctrl+C → Claude interrumpe el turno, muestra prompt nuevo
7. Redimensiono ventana → el TUI se acomoda sin desalinearse
8. Click en sesión vieja de la sidebar → PTY actual muere, spawn nuevo con
   --resume <id>, Claude muestra el histórico real de esa sesión y acepta
   continuación ("¿cuántos archivos eran?" responde con contexto)
9. Cmd+C con texto seleccionado → portapapeles; Cmd+V pega; Cmd+K limpia
```

Si los 9 pasan, PoC aprobada.

## Riesgos y mitigaciones

| # | Riesgo | Mitigación |
|---|--------|-----------|
| 1 | macOS GUI app inherita PATH vacío → `claude` no encuentra `node`/`git`/`rg` | `shell_env.rs` con `probe_shell_env` de OpenCode (spawn shell -il con `env -0`, parse null-delimited). Fallback a `-l` si `-il` timeouts. |
| 2 | Sin `TERM=xterm-256color` Claude no saca colores | Setear en env del child siempre. |
| 3 | Resize desalinea el TUI | xterm `onResize` → `invoke("pty_resize", { id, cols, rows })` con debounce 50ms. ResizeObserver en el contenedor. |
| 4 | Cmd+C intercepta copy y manda SIGINT | xterm `attachCustomKeyEventHandler` — si Cmd está activo y hay selección, devolver false (no pasar al PTY). |
| 5 | PTY zombie al cerrar ventana | `kill_on_drop` no aplica a `portable-pty`; registrar cleanup en `app.on_window_event` con `CloseRequested`. |
| 6 | Bytes del PTY no son UTF-8 válido | `pty:data:<id>` emite base64; frontend decodifica con `atob` → `Uint8Array` → xterm `write()`. |
| 7 | `portable-pty` read en thread bloqueante | Hacer read en `tokio::task::spawn_blocking` que empuja al `mpsc`; receiver async emite eventos. |

## Tareas (en orden)

### T1 — Limpiar código del Sprint 00
- [ ] Borrar `src-tauri/src/claude.rs`
- [ ] Borrar `src/context/claude.tsx`
- [ ] Borrar `src/components/chat-view.tsx`
- [ ] Borrar `src/lib/claude-events.ts` (el archivo entero)
- [ ] En `sessions.rs`: eliminar `list_session_entries` (no se usa)
- [ ] En `lib.rs`: quitar referencias a `claude` module + comandos viejos
- [ ] `cargo check` + `bun run typecheck` limpios

### T2 — Dependencias
- [ ] `cargo add portable-pty`
- [ ] `bun add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links`

### T3 — `shell_env.rs`
Port directo de OpenCode `packages/desktop/src-tauri/src/cli.rs` líneas 220-365:
- `get_user_shell()` → `$SHELL` o `/bin/sh`
- `probe_shell_env(shell, mode) -> ShellEnvProbe` (spawn `shell <mode> -c "env -0"` con timeout)
- `load_shell_env(shell) -> Option<HashMap>` (intenta `-il`, fallback `-l`)
- `merge_shell_env(shell_env, overrides)` (overrides ganan)
- Skip nushell.

### T4 — `pty.rs`
State: `Mutex<HashMap<String, PtySession>>` donde `PtySession` guarda master writer + child + abort handle del read loop.

Comandos:
- `pty_open(project_path, args) -> Result<String, String>` — uuid, setea cwd, merge env, spawn.
- `pty_write(id, base64) -> Result<(), String>`
- `pty_resize(id, cols, rows) -> Result<(), String>`
- `pty_kill(id) -> Result<(), String>`

Read loop: `spawn_blocking` lee del master en chunks de 4KB, envía por `mpsc`; un task async consume y emite `pty:data:<id>` (payload = base64 del chunk). Cuando child exits, emit `pty:exit:<id>` con code.

### T5 — Frontend: `context/terminal.tsx`
Store minimalista `{ id: string | null, status: "idle" | "running" | "exited" }`. Funciones `open(projectPath, args)`, `write(bytes)`, `resize(cols, rows)`, `kill()`. Listener de `pty:data:<id>` y `pty:exit:<id>`.

### T6 — Frontend: `components/terminal-view.tsx`
- Mount xterm.js en un `<div ref>`.
- Addons: `FitAddon`, `WebLinksAddon`.
- Theme hardcodeado oscuro.
- `term.onData` → `terminal.write(bytes)` (encode a base64).
- `term.onResize` → debounced `terminal.resize(cols, rows)`.
- Window resize / `ResizeObserver` → `fitAddon.fit()` → `onResize` callback dispara `pty_resize`.
- `attachCustomKeyEventHandler` para Cmd+C/V/K.
- Al desmontar: `kill()` + `term.dispose()`.

### T7 — Wire en `App.tsx`
Reemplazar el mount de `ChatView` por `TerminalView`.
Al cambiar `activeSessionId` o click en "+ Nueva":
- `await term.kill()` (si hay uno)
- `await term.open(projectPath, args)` con args según la acción.
`handleChangeProject` también mata el PTY.

### T8 — Validación manual
Correr los 9 pasos, llenar `docs/sprint-01-results.md`.

## Métricas a capturar

- **Latencia ventana → prompt de Claude**: ms desde click "+ Nueva" hasta `> _` visible.
- **Latencia input → eco**: ms desde keypress hasta aparecer en terminal.
- **Memoria**: `ps -o rss` del proceso Tauri con una sesión corriendo.
- **LOC** Rust + TS del sprint.

## Criterios de salida

- [ ] 9 pasos pasan
- [ ] `cargo check` + `cargo clippy -- -D warnings` limpios
- [ ] `bun run typecheck` limpio
- [ ] `docs/sprint-01-results.md` firmado
- [ ] Merge a `main` y tag `v0.1.0-pty`

## Sprint 02 natural (no-scope)

- Multi-tab de sesiones concurrentes
- File tree básico (Fase 2 de PROJECT.md)
- Persistencia de último session id por proyecto
