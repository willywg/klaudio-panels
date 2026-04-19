# Sprint 02 — Resultados (Multi-tab, persist, multi-proyecto)

> **Fecha:** 2026-04-19
> **Branch:** `sprint-02-multi-tab`
> **Tag al merge:** `v0.2.0`
> **Veredicto:** ✅ **APROBADA** — iteración extensa pero con funcionalidad consolidada.

## Scope final (más amplio que el PRP original)

El PRP 003 apuntaba a *multi-tab + persist*. Durante la validación el usuario pidió sumar un **shell rediseñado al estilo OpenCode**: sidebar de proyectos tipo Slack + home screen con proyectos recientes. Eso se hizo en commits separados dentro del mismo sprint, sin extender timeline.

## Qué quedó funcionando

### Multi-tab de sesiones (scope PRP 003)
- Backend PTY ya soportaba N sesiones concurrentes (`HashMap<id, PtySession>`) — solo cambió el frontend.
- `TerminalContext` refactor: `{ tabs: Tab[], activeTabId }` con API por-id (`openTab / closeTab / setActiveTab / write / resize / onData / onExit / findTabBySessionId`).
- `TabStrip` (lucide icons, status dot por color, × hover, botón +).
- Overlay de N `TerminalView` con `visibility + z-index` toggle — xterm instances NUNCA se destruyen al cambiar de tab (scrollback preservado).
- Click en sesión ya abierta del sidebar → activa el tab existente, no duplica PTY.

### Persistencia (scope PRP 003)
- `localStorage["lastSessionId:<projectPath>"]` — la última sesión activa por proyecto.
- Auto-resume al reabrir proyecto: lee `list_sessions_for_project` para recuperar el título real (`custom-title` de `/rename` o `summary`) ANTES del spawn.
- Fallback silencioso si la sesión fue borrada (limpia la key, placeholder limpio).

### Shell multi-proyecto (scope adicional del usuario)
- `ProjectsSidebar` (columna 56px): avatars con inicial + color determinístico por path. Badge verde con # de tabs abiertos. Icono Home arriba para ir al home screen. `+` abajo para agregar proyecto.
- `HomeScreen`: cuando no hay proyecto activo, muestra "Proyectos recientes" ordenados por `lastOpened` + botón "Abrir proyecto".
- **Pin/unpin** como conceptos separados:
  - Sidebar muestra `pinned`. Home muestra todos (`list`) ordenados por recencia.
  - `×` o right-click sobre un avatar del sidebar → mata sus PTYs + unpin. El proyecto sigue en Home.
  - Click en él desde Home → vuelve a pinnear + auto-resume.
- **Drag-and-drop custom** (PointerEvent manual): HTML5 drag no funcionaba en WebKit de Tauri (dropEffect no respetado, drop no siempre disparaba). Manual con threshold de 180ms de hold o 4px de movimiento. Slack-style: drag down → drop AFTER target, drag up → drop BEFORE.
- **Tabs por-proyecto sin matar PTYs** al cambiar: cada tab retiene su `projectPath`. TabStrip filtra. `activeByProject` Map recuerda el tab activo de cada proyecto.

### Títulos reales de sesión
- `sessions.rs` scan del JSONL captura `type:"custom-title"` (para `/rename`) y `type:"summary"` (auto-generado por Claude).
- `displayLabel(s)` prioridad: `custom_title > summary > first_message_preview > short id`.
- Auto-refresh del sidebar al abrir/cerrar tab → captura renames hechos durante la sesión + cerrada. Botón manual de refresh 🔄 en el header.
- Limitación conocida: el label del TAB activo no se actualiza al `/rename` en vivo (requiere watcher de JSONL — Sprint 03).

## Bugs encontrados y resueltos durante QA

| # | Síntoma | Causa raíz | Fix |
|---|---------|------------|-----|
| 1 | Proyecto nuevo no aparecía en el sidebar al click + | `createSignal` a nivel módulo: HMR creaba instancias nuevas sin re-suscribir consumidores. | Migrado a `ProjectsProvider` context + `createStore`. |
| 2 | Terminal en blanco al volver de otro proyecto | xterm WebGL detiene repaint cuando canvas está `visibility: hidden`. | `term.refresh(0, rows-1)` en el effect de `active`. |
| 3 | Terminal **en blanco tras spawn** (race condition) | Rust generaba el UUID dentro de `pty_open` y emitía `pty:data:<id>` inmediatamente, JS suscribía listeners DESPUÉS del `await invoke()` → bytes iniciales perdidos. | JS genera `crypto.randomUUID()` y llama `attachListeners` ANTES del invoke. `pty_open` recibe `id` como parámetro. |
| 4 | Drag hacia abajo no reordenaba visualmente | Siempre insertaba antes del target → drag-down dejaba el item 1 posición antes del target (imperceptible). | Slack-style: `splice(toIdx)` directo tras remove — aprovecha el shift natural. |
| 5 | Cursor siempre "grab" aunque no estés arrastrando | `cursor-grab` estático en la clase. | Removido del base. Cursor cambia a `grabbing` solo durante drag activo. |
| 6 | Click rápido en sesión spammeaba N tabs duplicados | Dedup `findTabBySessionId` corría antes que el tab existiera en el store (async gap). | Pending-tab pattern: tab insertado en store ANTES del invoke con `status:"opening"`. Dedup ahora encuentra el pending. |
| 7 | Tabs vs proyecto: ambos avatars activos | Dos lugares calculaban el switch (`switchToProject` + un effect) → race. | Colapsado a único entry point `setActiveProjectPath` + un único `createEffect(on(activeProjectPath))` para picking. |
| 8 | Cerrar proyecto desde sidebar también lo borraba del Home | `remove()` hacía full-delete. | Separé en `unpin()` (pinned=false) vs `remove()` (full delete). Sidebar usa `unpin`. |
| 9 | Iconos ⌂ + × unicode se veían pequeños/pixelados | Chars unicode en lugar de SVG. | `lucide-solid`: Home, Plus, X, FolderOpen, RefreshCw. Sidebar a 56px, avatars 40px. |
| 10 | Auto-resume mostraba "session xxxxxxxx" en lugar del título | Solo conocía el id, no el meta. | `maybeAutoResume` llama `list_sessions_for_project` primero, luego `displayLabel(meta)`. |

## Métricas

- **Diff vs `main`:** +2,008 / −230 en 21 archivos.
- **LOC TS/TSX nuevos:** `projects-sidebar.tsx` (216), `home-screen.tsx` (92), `projects.tsx` (132), `tab-strip.tsx` (78), `session-label.ts` (24), `recent-projects.ts` (79), `last-session.ts` (26).
- **Rust:** solo cambios en `pty.rs` (id desde frontend) + `sessions.rs` (extrae `custom-title` y `summary`). `uuid` crate removido.
- **Commits del sprint:** 10.
- **Deps nuevas:** `lucide-solid@1.8.0` (iconos). Cero nuevas deps Rust.

## Decisiones que confirmó la validación

- **JS posee el UUID del PTY.** Evita race entre Rust-emit y JS-listen. Aplica a TODO futuro `pty:*:<id>` channel.
- **PointerEvent manual > HTML5 drag** en Tauri WebKit. Control fino de click vs drag threshold, sin pelear con el webview.
- **Pin ≠ remove.** La semántica separada es la correcta: "cerrar del sidebar" no debería borrar historial.
- **ProjectsProvider + createStore** es la forma correcta de estado compartido reactivo en Solid. `createSignal` a nivel módulo da dolor de cabeza con HMR.

## Limitaciones conocidas (conscientes, defer)

- **Rename en vivo** no se refleja en el tab activo (solo al cerrar-reabrir). Requiere tailer del JSONL → Sprint 03.
- **Drag granular estilo Slack** (línea horizontal between items según cursor Y). Actualmente usa "before/after" basado en fromIdx vs toIdx. 95% de los casos.
- **Una sola ventana.** Multi-ventana está fuera de scope.
- **Sin keyboard shortcuts** (Cmd+T nuevo tab, Cmd+W cerrar, Cmd+1-9 activar). Sprint 04+.
- **Sin SQLite.** Todo en localStorage. Suficiente hasta Sprint 04/05.

## Qué sigue (Sprint 03 propuesto)

Del backlog original de PROJECT.md, pendientes en orden de valor:

1. **File tree + `notify` watcher** — lateral lazy, cambios del filesystem en vivo. Habilita ver qué archivos toca Claude en tiempo real.
2. **JSONL watcher** — resuelve rename-en-vivo + permite correlacionar tabs "new" con su sessionId real cuando Claude escribe el primer JSONL.
3. **Diff badges vía `git status`** — los archivos modificados se resaltan en el file tree.
4. **Diff viewer con `@pierre/diffs`** — click en un archivo modificado muestra el diff.
