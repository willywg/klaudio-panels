# Sprint 01 — PoC: Claude Code dentro de Tauri

> **Duración objetivo:** 3–5 días de trabajo efectivo
> **Estado:** Planeado
> **Objetivo único:** demostrar que el canal primario (`claude -p --output-format stream-json`) funciona dentro de un Tauri app real, con selección de proyecto y listado/continuación de sesiones existentes.

## Veredicto de factibilidad

**Factible, con confianza alta.** Fundamentos:

- **Claudia lo hace hoy** (`getAsterisk/claudia`, Tauri + React + `claude -p stream-json`). Código de referencia en `~/proyectos/open-source/claudia/src-tauri/src/commands/claude.rs`.
- El usuario ya tiene **39 proyectos** con sesiones en `~/.claude/projects/` — hay data real para probar sin setup.
- `claude -p --output-format stream-json` + `--resume <id>` son flags públicos y estables.

**Riesgos concretos** (ver sección abajo): (a) codificación del nombre de directorio de proyecto no es reversible — hay que leer `cwd` del JSONL; (b) autenticación del CLI está fuera de scope — la app asume que `claude` ya fue autenticado vía el CLI.

---

## Scope de la PoC

### Dentro
1. App Tauri v2 + SolidJS que abre una ventana.
2. **Dialog "Abrir proyecto"** → elige una carpeta del sistema.
3. **Lista de sesiones existentes** para ese proyecto, leídas de `~/.claude/projects/`, ordenadas por fecha. Cada entrada muestra: timestamp + primer mensaje del usuario (truncado).
4. Dos acciones:
   - **"Nueva sesión"** → spawn `claude -p ... stream-json --verbose` sin `--resume`.
   - **"Continuar <session>"** → spawn con `--resume <id>`.
5. **Vista de chat mínima** que renderiza eventos stream-json:
   - `system/init` → capturar `session_id` (mostrar en header).
   - `assistant` → bloque de texto markdown.
   - `user` → echo del prompt.
   - `tool_use` → card compacta con `name` + `input` resumido (sin diff viewer aún).
   - `tool_result` → `is_error`, texto truncado.
   - `result` → tokens + costo + duración.
6. **Input de prompt** → enviar una vez por turno. Un turno spawneea un proceso nuevo de `claude -p` con el último `session_id` como `--resume`.
7. **Cancel** → botón para matar el proceso actual (kill del child).

### Fuera (explícito)
- ❌ File tree, file viewer, editor
- ❌ Git diff, review panel
- ❌ Terminal libre con PTY (Fase 4)
- ❌ Multi-sesión concurrente (una activa a la vez)
- ❌ Settings UI, theming custom, i18n
- ❌ SQLite de app — la PoC guarda el último proyecto abierto en `localStorage`
- ❌ Model picker — hardcodeado el default (`sonnet`)
- ❌ Packaging / auto-update — `bun tauri dev` es suficiente
- ❌ Markdown rendering pulido — un `<pre>` con el texto basta para validar

---

## User flow (acceptance)

```
1. Corro `bun tauri dev`
2. Ventana abre → pantalla "Abrir proyecto" con un solo botón
3. Click botón → dialog nativo → selecciono /Users/willywg/proyectos/construct-ai/copilot-agent
4. UI cambia a layout de 2 columnas:
   - Izq: lista de sesiones de ese proyecto (ej. 8 sesiones con fecha + preview)
   - Der: vacío + botón "Nueva sesión"
5. Click "Nueva sesión" → panel derecho muestra chat vacío + input
6. Escribo "hola, ¿qué hay en este repo?" → enter
7. Veo:
   - mi mensaje arriba
   - header del chat actualizado con session_id real
   - tarjetas de tool_use (Bash/Read/Glob) apareciendo en orden
   - mensajes del assistant streameándose
   - evento `result` al final con tokens/costo
8. Refresh app (Cmd+R) → mismo proyecto se recuerda → la sesión recién creada
   aparece en la lista con su primer mensaje como preview
9. Click en esa sesión → panel derecho carga "Continuar" → escribo
   "y ahora cuántos archivos tiene?" → veo que Claude responde con contexto
   de la conversación anterior (prueba de que --resume funciona)
```

Si los 9 pasos funcionan sin excepciones, la PoC está aprobada.

---

## Riesgos a validar

| # | Riesgo | Cómo se mitiga en la PoC |
|---|--------|--------------------------|
| 1 | **Codificación de path** — `/Users/willywg/proyectos` ↔ `-Users-willywg-proyectos` no es reversible si hay guiones en el path real. | No decodificamos el nombre del directorio. Leemos el **primer evento de cada `.jsonl`** que contiene el campo `cwd` con el path real. Matching proyecto ↔ directorio se hace comparando `cwd`. |
| 2 | **Binary de `claude` no encontrado** | `binary.rs` usa `which` crate + fallbacks (~/.local/bin, /usr/local/bin, nvm shims). Si falla, UI muestra diálogo con link a `npm i -g @anthropic-ai/claude-code`. |
| 3 | **Autenticación del CLI** — si `claude` no está autenticado, `-p` falla silenciosamente o pide login interactivo. | Fuera de scope de la PoC. Asumimos que el usuario ya corrió `claude` al menos una vez. Si `-p` devuelve error, lo mostramos crudo. |
| 4 | **Path encoding de nuevas sesiones** — cuando spawneamos `claude` en un proyecto nuevo, ¿crea el `.jsonl` con la codificación esperada? | Se valida en paso 8 del user flow: abrimos el proyecto, creamos sesión, refresh, verificamos que aparezca en la lista. |
| 5 | **Stream-json buffering** — `tokio::BufReader::lines()` puede no entregar líneas hasta que se llene el buffer. | Usamos `read_until('\n')` explícito o `BufReader::lines()` con stdout unbuffered del lado de `claude` (stream-json ya hace flush por línea). Si hay lag perceptible, forzamos `stdbuf -oL` o similar. |
| 6 | **Cancelación deja zombie** — matar el proceso Rust no siempre mata al subproceso `claude`. | Usar `process-wrap` con `ProcessGroup::leader()` en Unix (patrón de OpenCode `cli.rs` líneas 471-474). Este pedazo sí aplica de OpenCode. |
| 7 | **Primer mensaje del usuario inútil** — a veces el primer `role: user` del JSONL es un system/command interno (ej. `<command-name>init`). | Filtrar: skip si empieza con `<command-name>`, `<local-command-stdout>`, o contiene "Caveat: The messages below were generated". Patrón de Claudia `extract_first_user_message`. |

---

## Tareas (en orden de ejecución)

### T1 · Scaffold (30 min)
- `bun create tauri-app claude-desktop --template solid-ts` (en ruta temporal, luego mover contenido a este repo sin pisar `PROJECT.md`/`CLAUDE.md`/`docs/`/`PRPs/`)
- Verificar `bun tauri dev` abre ventana
- Setup TailwindCSS v4 + `@tailwindcss/vite`
- Commit inicial del scaffold

### T2 · Detección del binary de Claude (1 h)
- `src-tauri/src/binary.rs`
- Port simplificado de `~/proyectos/open-source/claudia/src-tauri/src/claude_binary.rs`
- Comando Tauri: `get_claude_binary() -> Result<String, String>`
- Test manual: devuelve path absoluto

### T3 · Listado de proyectos y sesiones (2–3 h)
- `src-tauri/src/sessions.rs`
- Comandos:
  - `list_sessions_for_project(project_path: String) -> Vec<SessionMeta>`
    - `SessionMeta { id, timestamp, first_message_preview }`
    - Itera `~/.claude/projects/*/`, abre primer `.jsonl` de cada dir, compara `cwd` contra `project_path`, extrae sesiones
  - `list_session_entries(session_id: String) -> Vec<JsonlEntry>` (para render histórico al continuar)
- Referencia: Claudia `list_projects`, `extract_first_user_message` (líneas 193–230 de `commands/claude.rs`)

### T4 · Dialog de "Abrir proyecto" (30 min)
- Frontend: `@tauri-apps/plugin-dialog` → `open({ directory: true })`
- Guarda el path en `createSignal` + `localStorage`
- UI: pantalla inicial si no hay proyecto, layout principal si sí

### T5 · Spawn de Claude con stream-json (3–4 h) — **núcleo**
- `src-tauri/src/claude.rs`
- Comando Tauri: `claude_send(project_path, prompt, model, resume_session_id?) -> Result<(), String>`
- Flags: `-p <prompt> --model <model> --output-format stream-json --verbose [--resume <id>]`
- `tokio::Command` + `Stdio::piped()` + `process-wrap::ProcessGroup::leader()` (Unix)
- `BufReader::new(stdout).lines()` → por cada línea:
  - Parse JSON
  - Si `type == "system" && subtype == "init"` → capturar `session_id` en `Arc<Mutex<Option<String>>>`
  - Emit `claude:event:<session_id>` (o `claude:event:pending` si aún no hay)
- Comando `claude_cancel()` → kill del child
- Referencia: `spawn_claude_process` líneas 1174–1290 de Claudia

### T6 · Frontend chat view (3–4 h)
- `src/context/claude.tsx` — store `{ sessionId, messages, status }`
- Listener `listen<string>('claude:event:...')` con re-subscription cuando session_id se promueve de `pending` al real
- Componentes sueltos (sin librería de UI):
  - `<ChatHeader session_id model status />`
  - `<MessageUser text />`
  - `<MessageAssistant blocks />`
  - `<ToolCall name input collapsed />`
  - `<ToolResult text is_error />`
  - `<ResultSummary tokens cost duration />`
- Tailwind solamente, sin Kobalte en la PoC

### T7 · Layout + wiring (2 h)
- `src/App.tsx`: 2 columnas (sidebar 260px + main)
- Sidebar: lista de sesiones + botón "Nueva sesión"
- Main: chat o empty state
- Logic: click en sesión ↔ set `activeSessionId` → al enviar prompt pasa `resume_session_id`

### T8 · Validación manual (1 h)
- Correr los 9 pasos del user flow
- Documentar en `docs/sprint-01-results.md`: qué funcionó, qué falló, métricas (latencia primer evento, tamaño del código en LOC)
- Screenshots / video corto

---

## Criterios de salida (Definition of Done)

- [ ] `bun tauri dev` abre la app en macOS sin warnings
- [ ] Los 9 pasos del user flow pasan en cadena sin reload manual
- [ ] Cancelar una sesión activa mata el proceso `claude` (verificado con `ps aux`)
- [ ] Reabrir la app recuerda el último proyecto (localStorage)
- [ ] `cargo check` y `bun run typecheck` sin errores
- [ ] `docs/sprint-01-results.md` escrito con veredicto y siguientes pasos
- [ ] Commit final en branch `sprint-01-poc` con tag `v0.0.1-poc`

---

## Preguntas abiertas / decisiones a tomar

1. **¿Modelo hardcodeado o picker?** Recomiendo `sonnet` hardcodeado en la PoC; picker queda para Sprint 2.
2. **¿Render de markdown?** `<pre>` crudo basta para validar. `marked` o `shiki` entran en Sprint 2.
3. **¿Qué hacer si el proyecto elegido no tiene sesiones previas?** La lista arranca vacía; solo se muestra "Nueva sesión". Sin error.
4. **¿Multi-proyecto abierto simultáneamente?** No en la PoC. Un proyecto activo a la vez. Cambiar proyecto mata la sesión en curso.
5. **¿Dónde guardamos el `activeProjectPath` entre reloads?** `localStorage` (sin SQLite todavía).

---

## Siguiente sprint (no-scope)

Si la PoC pasa, Sprint 2 natural:
- File tree + file viewer (Fase 2 de PROJECT.md)
- Markdown rendering con Shiki
- Model picker
- SQLite para app settings
- Tests unitarios (ahora solo manual)
