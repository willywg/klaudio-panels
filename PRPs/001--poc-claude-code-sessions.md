# PRP: PoC — Claude Code sessions in Tauri

> **Version:** 1.0
> **Created:** 2026-04-16
> **Status:** Ready
> **Phase:** Sprint 01 (pre-Phase 1 of PROJECT.md)

---

## Goal

Demostrar en 3–5 días que podemos spawnear `claude -p --output-format stream-json --verbose` desde un Tauri v2 + SolidJS app, listar las sesiones existentes de un proyecto (leyendo `~/.claude/projects/`), y renderizar los eventos stream-json en una UI mínima — con capacidad de crear una sesión nueva, continuar una existente (`--resume <id>`), y cancelar el proceso. Sin file tree, sin diff, sin terminal libre, sin markdown pulido.

## Why

- **Desbloquea todo lo demás.** Si el canal primario (stream-json) no funciona confiablemente dentro de Tauri, el plan completo de PROJECT.md cae. Esta PoC lo valida con código real, no con asunciones.
- **Reduce riesgo arquitectónico temprano.** Antes de invertir en file tree, diff viewer o terminal, confirmamos que los supuestos clave (encoding de paths, flush de stream-json, kill de procesos) aguantan.
- **Entrega un "producto" funcional ya.** Aun como PoC, permite al usuario abrir un proyecto, retomar conversaciones viejas y tener una nueva — algo útil incluso sin el resto.

## What

Una ventana Tauri con flujo de 2 pantallas:

1. **Pantalla inicial** — botón "Abrir proyecto" (dialog nativo de directorio).
2. **Layout principal (2 columnas)** — sidebar izquierdo con lista de sesiones del proyecto + botón "Nueva sesión"; panel derecho con vista de chat (header con session_id, timeline de eventos, input).

### Success Criteria
- [ ] App abre con `bun tauri dev` sin warnings de Tauri/Vite.
- [ ] Selecto un proyecto que ya existe en `~/.claude/projects/` y veo sus sesiones listadas con fecha + preview del primer mensaje del usuario.
- [ ] Click en "Nueva sesión" + escribo prompt → veo streaming de eventos (system/init, tool_use, assistant, tool_result, result) en orden.
- [ ] Click en una sesión existente + envío mensaje → `--resume <id>` hace que Claude responda con contexto de la conversación anterior.
- [ ] Click "Cancelar" mientras corre → proceso muere (verificable con `ps aux | grep claude`).
- [ ] Recargo la app (Cmd+R) y recuerda el último proyecto elegido.
- [ ] La sesión recién creada aparece en la sidebar al refresh.
- [ ] `cargo check` + `bun run typecheck` pasan sin errores.

---

## All Needed Context

### Project-level references (always relevant)
```yaml
- file: PROJECT.md
  why: Blueprint completo, estrategia híbrida, stack decidido
- file: CLAUDE.md
  why: Reglas no-negociables (chat via pipes no PTY, sessions en ~/.claude/projects, etc.)
- file: docs/sprint-01-poc.md
  why: Scope del sprint, user flow de 9 pasos que sirve como acceptance test, tabla de riesgos
```

### Feature-specific references
```yaml
# CLAUDIA — referencia principal de integración con Claude Code
- file: ~/proyectos/open-source/claudia/src-tauri/src/claude_binary.rs
  why: Detección de `claude` (which + fallbacks + validación de versión)
  lines: 35-200

- file: ~/proyectos/open-source/claudia/src-tauri/src/commands/claude.rs
  why: spawn_claude_process — patrón exacto para stream-json emission per-session
  lines: 1174-1290
  critical: |
    - Captura session_id del primer evento `system`/`init`, NO antes
    - Emite a `claude-output:{session_id}` + channel genérico para backward compat
    - Mata proceso existente antes de spawnear uno nuevo (single-session model)

- file: ~/proyectos/open-source/claudia/src-tauri/src/commands/claude.rs
  why: extract_first_user_message + list_projects — parseo de JSONL
  lines: 180-330
  critical: |
    - Skip mensajes que empiezan con <command-name>, <local-command-stdout>
    - Skip si contiene "Caveat: The messages below were generated..."
    - get_project_path_from_sessions lee cwd del JSONL (no decodifica el dir name)

# OPENCODE — patrón útil de kill de procesos
- file: ~/proyectos/open-source/opencode/packages/desktop/src-tauri/src/cli.rs
  why: process-wrap ProcessGroup::leader() para matar el grupo entero
  lines: 471-479
  critical: "Sin esto, kill del child deja zombies cuando claude spawn sub-procesos (Bash tool)"

# Docs oficiales
- url: https://docs.anthropic.com/en/docs/claude-code/sdk
  why: Claude Code SDK docs — confirma flags -p, --output-format stream-json, --resume, -c
  critical: stream-json emite un JSON object por línea, terminated con \n

- url: https://v2.tauri.app/reference/javascript/api/namespaceevent/
  why: listen/emit para eventos stream

- url: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/dialog
  why: plugin-dialog open({ directory: true })
```

### Current repo state
```
claude-desktop/
├── .claude/
├── .git/
├── CLAUDE.md
├── PROJECT.md
├── PRPs/
│   ├── templates/prp_base.md
│   └── 001--poc-claude-code-sessions.md   # ← este archivo
└── docs/sprint-01-poc.md
```

**No hay scaffolding todavía.** La primera tarea lo crea.

### Desired structure after this PRP
```
claude-desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs              # Tauri setup, registra comandos, plugins
│       ├── binary.rs           # Detección de `claude` en PATH
│       ├── sessions.rs         # Parseo de ~/.claude/projects/**/*.jsonl
│       └── claude.rs           # Spawn stream-json + emit per-session
├── src/
│   ├── App.tsx                 # Layout 2-column + switcher proyecto/chat
│   ├── main.tsx                # Entry
│   ├── index.css               # Tailwind v4 base
│   ├── context/
│   │   └── claude.tsx          # Store + listener de eventos
│   ├── components/
│   │   ├── project-picker.tsx  # Empty state + dialog trigger
│   │   ├── sessions-list.tsx   # Sidebar con sesiones + botón "Nueva"
│   │   ├── chat-view.tsx       # Timeline de eventos + input
│   │   ├── message-user.tsx
│   │   ├── message-assistant.tsx
│   │   ├── tool-call.tsx
│   │   ├── tool-result.tsx
│   │   └── result-summary.tsx
│   └── lib/
│       ├── claude-events.ts    # Tipos del stream-json
│       └── bindings.ts         # Wrappers de invoke() tipados
├── package.json
├── vite.config.ts
├── tsconfig.json
└── tailwind.config.ts (si v4 lo requiere; puede ser solo @import)
```

### Known gotchas & project rules

```
FROM CLAUDE.md (NON-NEGOTIABLE):
- Chat = piped subprocess + JSON line parsing. NO PTY.
- Sessions live in ~/.claude/projects/ — do NOT create parallel storage.
- Filesystem + git = source of truth; no custom index.
- Don't copy OpenCode's cli.rs or terminal.tsx patterns for the chat.

CLAUDE CLI BEHAVIOR:
- `claude -p "<prompt>"` es one-shot. Cada turno spawnea un proceso nuevo.
- Para multi-turn: pasar --resume <session_id> del turno anterior.
- La primera vez (sesión nueva): omitir --resume; `session_id` llega en
  el primer evento `system`/`init` de stdout.
- --dangerously-skip-permissions existe pero NO lo usamos en la PoC —
  queremos ver prompts de permisos reales.
- El binario `claude` debe estar autenticado (usuario corrió `claude`
  al menos una vez). Si no, `-p` sale con error — lo mostramos crudo.

PATH ENCODING:
- ~/.claude/projects/ usa dir names tipo "-Users-willywg-proyectos-X".
- NO es reversible si el path original tiene "-". Ejemplo:
  "-Users-mufeed-dev-jsonl-viewer" podría ser
  "/Users/mufeed/dev/jsonl-viewer" o "/Users/mufeed/dev/jsonl/viewer".
- SOLUCIÓN: leer el campo `cwd` del primer JSONL entry de cada
  directorio. Ese `cwd` es el path absoluto real.

STREAM-JSON PARSING:
- Una línea = un JSON object. Usar BufReader::lines() (tokio).
- Eventos relevantes:
  {type: "system", subtype: "init", session_id, ...}
  {type: "user", message: { content: [...] }}
  {type: "assistant", message: { content: [{type: "text", text}, {type: "tool_use", id, name, input}, ...] }}
  {type: "user", message: { content: [{type: "tool_result", tool_use_id, content, is_error}] }}
  {type: "result", subtype: "success" | "error", cost_usd, duration_ms, num_turns, ...}
- tool_use y tool_result están anidados DENTRO de mensajes, no son tipos top-level.

PROCESS KILL:
- tokio::Process::kill() mata solo el child, no el grupo.
- claude spawneea sub-procesos (Bash, etc.) — quedan zombies.
- Fix: process-wrap crate con ProcessGroup::leader() en Unix.

TAURI V2 GOTCHAS:
- Eventos deben declararse en capabilities/default.json con permission
  "core:event:default" o específico.
- invoke handlers deben registrarse en lib.rs con tauri::generate_handler!
- macOS: si faltan entitlements, dialog no abre — incluir
  "com.apple.security.files.user-selected.read-write" si se hace DMG.
  Para dev con `bun tauri dev` generalmente no hace falta.

SOLIDJS GOTCHAS:
- No useState / useEffect — usar createSignal, createEffect, createMemo.
- createStore para updates anidados (ej. chat messages).
- Listeners de Tauri devuelven Promise<UnlistenFn>; cleanup en onCleanup.
- Si session_id cambia (pending → real), re-subscribe con createEffect
  dependiente del signal.

TAILWIND V4:
- No hay tailwind.config.js. Todo via @import "tailwindcss" en CSS
  + @theme {} para customización.
- Plugin: @tailwindcss/vite en vite.config.ts.
```

---

## Implementation Blueprint

### Data models / types

```typescript
// src/lib/claude-events.ts
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }

export type ClaudeEvent =
  | { type: "system"; subtype: "init"; session_id: string; model: string; cwd: string }
  | { type: "user"; message: { role: "user"; content: string | ContentBlock[] } }
  | { type: "assistant"; message: { role: "assistant"; content: ContentBlock[] } }
  | { type: "result"; subtype: "success" | "error"; session_id: string; cost_usd?: number; duration_ms?: number; num_turns?: number; is_error?: boolean }

export type SessionMeta = {
  id: string                    // session_id de Claude Code
  timestamp: string             // ISO del primer mensaje
  first_message_preview: string // truncado a ~100 chars
  project_path: string          // cwd real
}
```

```rust
// src-tauri/src/sessions.rs
#[derive(serde::Serialize, specta::Type, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub timestamp: Option<String>,
    pub first_message_preview: Option<String>,
    pub project_path: String,
}
```

### Tasks (en orden de ejecución)

```yaml
Task 1 — Scaffold:
  - RUN (in /tmp): bun create tauri-app claude-desktop-scaffold --template solid-ts --manager bun --yes --identifier com.willywg.claude-desktop
  - MERGE into current repo: mueve src/, src-tauri/, index.html, package.json, vite.config.ts, tsconfig*.json, .gitignore
  - KEEP existing: PROJECT.md, CLAUDE.md, docs/, PRPs/, .git/
  - EDIT .gitignore: agregar target/, dist/, node_modules/ si no están
  - INSTALL: bun add -d @tailwindcss/vite tailwindcss
  - INSTALL: bun add @tauri-apps/plugin-dialog
  - INSTALL Rust: cd src-tauri && cargo add tauri-plugin-dialog which process-wrap --features tokio1 dirs anyhow serde_json futures tokio-stream
  - CONFIGURE vite.config.ts: add @tailwindcss/vite plugin
  - CONFIGURE src/index.css: @import "tailwindcss";
  - REGISTER plugin-dialog: in src-tauri/src/lib.rs and tauri.conf.json
  - CAPABILITIES: add dialog:default to capabilities/default.json
  - VERIFY: bun tauri dev opens window

Task 2 — binary.rs:
  - CREATE: src-tauri/src/binary.rs
  - MIRROR pattern from: ~/proyectos/open-source/claudia/src-tauri/src/claude_binary.rs
  - IMPLEMENT: find_claude_binary() -> Result<PathBuf, String>
    1. `which claude` crate
    2. Fallbacks: $HOME/.claude/local/claude, /usr/local/bin/claude,
       /opt/homebrew/bin/claude, $HOME/.nvm/versions/node/*/bin/claude,
       $HOME/.volta/bin/claude, $HOME/.asdf/shims/claude
    3. Validate: exec `claude --version` with 2s timeout; must succeed
  - EXPOSE as #[tauri::command] get_claude_binary() -> Result<String, String>
  - REGISTER in lib.rs invoke_handler

Task 3 — sessions.rs:
  - CREATE: src-tauri/src/sessions.rs
  - IMPLEMENT:
    - fn claude_projects_dir() -> PathBuf  // ~/.claude/projects via dirs crate
    - fn read_cwd_from_jsonl(path: &Path) -> Option<String>
      → parse first N lines until finding a message with `cwd` field
    - fn extract_first_user_message(path: &Path) -> (Option<String>, Option<String>)
      → skip <command-name>, <local-command-stdout>, "Caveat:" prefixes
      → return (content, timestamp)
  - COMMANDS:
    - list_sessions_for_project(project_path: String) -> Vec<SessionMeta>
      → iterate ~/.claude/projects/*/*.jsonl
      → match cwd == canonicalized project_path
      → sort by timestamp desc
    - list_session_entries(session_id: String) -> Vec<serde_json::Value>
      → find the .jsonl by name, return all parsed lines
  - REGISTER both in lib.rs

Task 4 — Project picker (frontend):
  - CREATE: src/components/project-picker.tsx
  - USE: @tauri-apps/plugin-dialog open({ directory: true })
  - STATE in App.tsx: const [projectPath, setProjectPath] = createSignal<string | null>(
      localStorage.getItem("projectPath")
    )
  - EFFECT: createEffect(() => { if (projectPath()) localStorage.setItem("projectPath", projectPath()!) })
  - RENDER: if !projectPath() → <ProjectPicker onPick={setProjectPath} />
            else → main layout (Task 7)

Task 5 — claude.rs (stream-json spawn):
  - CREATE: src-tauri/src/claude.rs
  - STATE: struct ClaudeState { current: Arc<Mutex<Option<CommandChild>>> }
    → managed via app.manage()
  - COMMAND: claude_send(app, project_path, prompt, model, resume_session_id?)
    1. find_claude_binary() via binary.rs
    2. Build args:
       ["-p", &prompt, "--model", &model,
        "--output-format", "stream-json", "--verbose"]
       if let Some(sid) = resume_session_id { args.push("--resume"); args.push(&sid) }
    3. Kill existing current if any
    4. tokio::Command::new(bin).args(args).current_dir(&project_path)
       .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null())
    5. Wrap with process-wrap ProcessGroup::leader() (Unix) / JobObject (Windows)
    6. spawn → take stdout + stderr
    7. Spawn tokio task:
       let session_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
       loop read_line from stdout:
         parse as Value
         if type==system && subtype==init:
            session_id = v["session_id"] → emit "claude:session" { session_id }
         emit "claude:event:{session_id_or_pending}" with the raw line
       on EOF / error → emit "claude:done" { code }
    8. Store child in ClaudeState
  - COMMAND: claude_cancel(app) → kill whatever's in ClaudeState
  - REGISTER in lib.rs

Task 6 — Frontend chat context + components:
  - CREATE: src/context/claude.tsx
    - createStore<{ sessionId: string | null, messages: ChatMessage[], status: "idle" | "running" | "error" }>
    - fn send(prompt, model, resume_session_id?) → invoke("claude_send", ...)
    - listener on "claude:session" → set sessionId
    - listener on "claude:event:pending" AND "claude:event:{sessionId()}" via createEffect
    - process event → append to messages
  - CREATE: src/components/chat-view.tsx
    - <ChatHeader session_id status />
    - For each message: switch on type → <MessageUser /> | <MessageAssistant /> | <ToolCall /> | <ToolResult /> | <ResultSummary />
    - <form onSubmit → ctx.send> with textarea + submit + cancel button
  - CREATE leaf components (plain Tailwind)

Task 7 — Sidebar + layout:
  - EDIT: src/App.tsx
    - Grid: [260px 1fr]
    - Left: <SessionsList projectPath={...} onNew={...} onSelect={...} />
    - Right: <ChatView activeSessionId={...} />
  - CREATE: src/components/sessions-list.tsx
    - createResource(projectPath, (p) => invoke("list_sessions_for_project", { projectPath: p }))
    - Button "Nueva sesión" on top
    - List of SessionMeta with timestamp + preview (line-clamp-2)
    - Click → onSelect(session.id) → parent sets activeSessionId

Task 8 — Validation:
  - RUN the 9 steps from docs/sprint-01-poc.md §"User flow"
  - CREATE: docs/sprint-01-results.md with:
    - Steps passed / failed
    - Latency first-event (time from send → first stream-json line)
    - LOC count (rust + ts)
    - Bugs discovered
    - Decisions for Sprint 02
  - COMMIT + tag v0.0.1-poc
```

### Pseudocode — piezas críticas

```rust
// src-tauri/src/claude.rs — el corazón
use std::sync::Arc;
use tokio::{io::{AsyncBufReadExt, BufReader}, process::Command, sync::Mutex};
use std::process::Stdio;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct ClaudeState { pub current: Arc<Mutex<Option<tokio::process::Child>>> }

#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    project_path: String,
    prompt: String,
    model: String,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    // 1. Kill existing
    if let Some(mut old) = state.current.lock().await.take() {
        let _ = old.kill().await;
    }

    // 2. Find binary
    let bin = crate::binary::find_claude_binary().map_err(|e| e.to_string())?;

    // 3. Build args
    let mut args: Vec<String> = vec![
        "-p".into(), prompt,
        "--model".into(), model,
        "--output-format".into(), "stream-json".into(),
        "--verbose".into(),
    ];
    if let Some(id) = resume_session_id {
        args.push("--resume".into()); args.push(id);
    }

    // 4. Spawn (TODO: wrap with process-wrap ProcessGroup::leader() for real kill)
    let mut cmd = Command::new(&bin);
    cmd.args(&args).current_dir(&project_path)
       .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // 5. Reader task
    let app2 = app.clone();
    tokio::spawn(async move {
        let session_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Parse to capture session_id on system/init
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v["type"] == "system" && v["subtype"] == "init" {
                    let mut sid = session_id.lock().await;
                    if sid.is_none() {
                        if let Some(id) = v["session_id"].as_str() {
                            *sid = Some(id.to_string());
                            let _ = app2.emit("claude:session", id);
                        }
                    }
                }
            }
            let channel = match &*session_id.lock().await {
                Some(id) => format!("claude:event:{id}"),
                None => "claude:event:pending".to_string(),
            };
            let _ = app2.emit(&channel, &line);
        }
        let _ = app2.emit("claude:done", ());
    });

    // stderr → just log
    let app3 = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app3.emit("claude:stderr", &line);
        }
    });

    *state.current.lock().await = Some(child);
    Ok(())
}

#[tauri::command]
pub async fn claude_cancel(state: State<'_, ClaudeState>) -> Result<(), String> {
    if let Some(mut child) = state.current.lock().await.take() {
        child.kill().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

```typescript
// src/context/claude.tsx — listener con session-id promotion
import { createContext, createEffect, onCleanup, ParentProps, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { listen, UnlistenFn } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import type { ClaudeEvent } from "@/lib/claude-events"

type ChatMsg =
  | { kind: "user"; text: string }
  | { kind: "assistant"; blocks: any[] }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { kind: "result"; cost_usd?: number; duration_ms?: number; is_error?: boolean }

type Store = {
  sessionId: string | null
  messages: ChatMsg[]
  status: "idle" | "running" | "error"
}

const Ctx = createContext<ReturnType<typeof make>>()
function make() {
  const [store, setStore] = createStore<Store>({ sessionId: null, messages: [], status: "idle" })

  // Session listener
  let unSession: UnlistenFn | undefined
  listen<string>("claude:session", (e) => setStore("sessionId", e.payload))
    .then((u) => (unSession = u))

  // Done listener
  let unDone: UnlistenFn | undefined
  listen("claude:done", () => setStore("status", "idle")).then((u) => (unDone = u))

  // Dynamic event listener (re-subscribes when sessionId changes)
  createEffect(() => {
    const sid = store.sessionId ?? "pending"
    let unEvent: UnlistenFn | undefined
    listen<string>(`claude:event:${sid}`, (e) => {
      const ev = JSON.parse(e.payload) as ClaudeEvent
      applyEvent(setStore, ev)
    }).then((u) => (unEvent = u))
    onCleanup(() => unEvent?.())
  })

  onCleanup(() => {
    unSession?.()
    unDone?.()
  })

  async function send(projectPath: string, prompt: string, model: string, resumeId?: string) {
    // Optimistic user message
    setStore("messages", (m) => [...m, { kind: "user", text: prompt }])
    setStore("status", "running")
    if (!resumeId) setStore("sessionId", null) // reset to listen on "pending"
    try {
      await invoke("claude_send", {
        projectPath, prompt, model, resumeSessionId: resumeId ?? null,
      })
    } catch (err) {
      setStore("status", "error")
      console.error(err)
    }
  }

  async function cancel() { await invoke("claude_cancel"); setStore("status", "idle") }

  return { store, send, cancel }
}

function applyEvent(setStore: any, ev: ClaudeEvent) {
  // Simplified dispatch — flesh out in Task 6
  if (ev.type === "assistant") {
    setStore("messages", (m: ChatMsg[]) => [...m, { kind: "assistant", blocks: ev.message.content }])
    // TODO: extract tool_use blocks into separate entries for cleaner UI
  } else if (ev.type === "result") {
    setStore("messages", (m: ChatMsg[]) => [...m, { kind: "result", cost_usd: ev.cost_usd, duration_ms: ev.duration_ms, is_error: ev.is_error }])
    setStore("status", "idle")
  }
  // Ignore type === "user" (we already added the optimistic one)
}

export function ClaudeProvider(props: ParentProps) {
  return <Ctx.Provider value={make()}>{props.children}</Ctx.Provider>
}
export function useClaude() {
  const v = useContext(Ctx)
  if (!v) throw new Error("useClaude outside ClaudeProvider")
  return v
}
```

### Integration points

```yaml
TAURI_CAPABILITIES (src-tauri/capabilities/default.json):
  - "core:default"
  - "core:event:default"          # listen/emit
  - "dialog:default"              # plugin-dialog
  - custom commands (auto-granted if in invoke_handler)

TAURI_PLUGINS (src-tauri/src/lib.rs):
  .plugin(tauri_plugin_dialog::init())
  .manage(ClaudeState { current: Arc::new(Mutex::new(None)) })
  .invoke_handler(tauri::generate_handler![
      binary::get_claude_binary,
      sessions::list_sessions_for_project,
      sessions::list_session_entries,
      claude::claude_send,
      claude::claude_cancel,
  ])

VITE (vite.config.ts):
  import tailwindcss from "@tailwindcss/vite"
  plugins: [solid(), tailwindcss()]

CSS (src/index.css):
  @import "tailwindcss";
  @theme { /* optional custom tokens */ }
```

---

## Validation Loop

### Level 1: Syntax & style
```bash
# Frontend
bun run typecheck       # tsc --noEmit

# Rust
cd src-tauri && cargo check && cargo clippy -- -D warnings
```

### Level 2: Unit tests
> Sin suite formal en PoC. Test manual cubre los paths críticos.

Opcional si el tiempo alcanza:
- Test de `extract_first_user_message` con fixtures (`.jsonl` de muestra).
- Test de `find_claude_binary` mockeando PATH.

### Level 3: Integración manual — los 9 pasos de `docs/sprint-01-poc.md`

```bash
bun tauri dev
```

1. Ventana abre → pantalla "Abrir proyecto".
2. Click botón → dialog nativo → seleccionar `/Users/willywg/proyectos/construct-ai/copilot-agent` (o cualquier proyecto con sesiones reales).
3. UI cambia a layout 2-col con sesiones listadas.
4. Click "Nueva sesión" → panel chat vacío + input.
5. Escribir "hola, ¿qué hay en este repo?" + enter.
6. Observar: mi mensaje → system/init con session_id → tool_use (Bash/Read/Glob) → assistant streaming → result.
7. Refresh (Cmd+R): mismo proyecto recordado; nueva sesión aparece en sidebar.
8. Click en esa sesión + enviar "y cuántos archivos?" → Claude responde con contexto.
9. Mientras corre un turno → click "Cancelar" → proceso muere (`ps aux | grep claude` no muestra nada).

Expected:
- Primer evento (`system/init`) llega en < 3s.
- Sin errores rojos en consola de devtools.
- `~/.claude/projects/<encoded>/<new-session-id>.jsonl` creado en disco.
- `cargo check` + `bun run typecheck` limpios.

---

## Final Checklist

- [ ] Task 1 — Scaffold + Tailwind configurado, `bun tauri dev` corre
- [ ] Task 2 — `get_claude_binary` devuelve path válido
- [ ] Task 3 — `list_sessions_for_project` devuelve sesiones reales ordenadas
- [ ] Task 4 — Dialog abre, localStorage persiste
- [ ] Task 5 — `claude_send` emite eventos stream-json; cancel funciona
- [ ] Task 6 — Chat view renderiza los 4 tipos de mensaje
- [ ] Task 7 — Layout completo con sidebar wiring
- [ ] Task 8 — 9 pasos pasan; `docs/sprint-01-results.md` escrito
- [ ] `cargo check` + `cargo clippy -- -D warnings` limpios
- [ ] `bun run typecheck` limpio
- [ ] Commit final tagged `v0.0.1-poc`

---

## Anti-Patterns to Avoid

- ❌ Usar PTY para el chat — la PoC es específicamente para validar piped stream-json
- ❌ ANSI-parsear la salida — ignorar stderr de claude para este sprint
- ❌ Inventar un store de sesiones en SQLite o JSON — usar `~/.claude/projects/` directo
- ❌ Usar `--dangerously-skip-permissions` — queremos ver prompts reales
- ❌ Copiar `cli.rs` de OpenCode (es HTTP sidecar, patrón incorrecto)
- ❌ Decodificar el nombre del directorio con `.replace('-', '/')` — NO es reversible
- ❌ Intentar multi-sesión concurrente — una activa a la vez
- ❌ Agregar features fuera del scope (model picker, markdown shiki, file tree, diff)

---

## Notes

- **Confidence: 8/10** para one-pass. Claudia valida el patrón al 100%; el riesgo residual es el scaffold + Tailwind v4 (pueden aparecer warnings/config menores).
- **Tiempo estimado:** 3–5 días efectivos según sprint doc.
- **Después de la PoC**, Sprint 02 natural: file tree + file viewer + markdown rendering + model picker. SQLite de settings entra en Sprint 03.
- **Decisión sobre markdown:** en la PoC rendereamos `<pre>` crudo. `marked` + `shiki` entra en Sprint 02.
