# Sprint 02 — Multi-tab + persistencia de última sesión

> **Status:** Planning → Ready to execute
> **Branch:** `sprint-02-multi-tab` (se crea al arrancar T1)
> **PRP:** [PRPs/003--multi-tab-and-session-persist.md](../PRPs/003--multi-tab-and-session-persist.md)
> **Base:** `main` (commit del merge de `sprint-01-pty`, tag `v0.1.0-pty`)

## Objetivo

Permitir tener **múltiples sesiones de Claude Code abiertas simultáneamente** en tabs dentro de la misma ventana, y **auto-resumir la última sesión activa** al reabrir un proyecto.

## Decisiones de diseño (ya tomadas)

1. **Tabs arriba del terminal** (opción A, confirmada por el usuario). Rechazada la opción B (indicadores en sidebar) — los tabs son el patrón universal para instancias paralelas y liberan la sidebar.
2. **Single-window** — no hay multi-ventana en este sprint.
3. **xterm persistence** = mantener N instancias montadas, conmutar visibility (no `display: none` — rompe FitAddon/WebGL).
4. **Persistencia** = `localStorage["lastSessionId:<projectPath>"]` solamente. **NO** se persiste la lista completa de tabs abiertos. SQLite es Sprint 03/04.
5. **Tab id = PTY UUID**. Tabs "new" (sin `--resume`) viven con `sessionId: null`; correlacionar con el JSONL es trabajo de Sprint 03.
6. **Semántica de click en sidebar** — si ya hay tab abierto para esa sesión → activar ese tab. Si no → abrir tab nuevo. NUNCA reemplazar el tab activo.
7. **Fuera de scope:** keyboard shortcuts (Cmd+T/W/1-9), reorder drag-and-drop, límite de tabs, toast UI, SQLite.

## Tasks (ejecución en orden)

| # | Archivo | Qué hace |
|---|---|---|
| T1 | `src/context/terminal.tsx` | Refactor a `{ tabs, activeTabId }` + APIs por-id. Listeners y handler sets por tab. |
| T2 | `src/components/terminal-view.tsx` | Acepta `id` prop. No llama `ctx.kill()` en `onCleanup`. Expone `refit()` para visibility-toggle. |
| T3 | `src/components/tab-strip.tsx` *(nuevo)* | Fila de tabs con label truncado + status dot + close × + botón `+`. Overflow-x-auto. |
| T4 | `src/App.tsx` | Renderiza TabStrip + overlay de N `TerminalView` con visibility toggle. `createEffect` para refit al cambiar activeTabId. |
| T5 | `src/App.tsx` + `src/components/last-session.ts` *(nuevo)* | handleNew / handleSelect / handleCloseTab + persistencia `lastSessionId` en localStorage. |
| T6 | `src/App.tsx` | `onMount`: si hay `lastSessionId` válido, auto-resume un tab. Fallback silencioso si exit code ≠ 0 en <2s. |
| T7 | `src/components/sessions-list.tsx` | Prop `openSessionIds: Set<string>` + dot verde en sesiones que ya están en tab. |
| T8 | `CLAUDE.md` + `docs/sprint-02-results.md` | Actualizar regla #9 (single-PTY → multi-PTY tabs). Validación manual + resultados. |

**Backend Rust no se toca** salvo fixes encontrados durante la integración. `src-tauri/src/pty.rs` ya soporta N PTYs concurrentes.

## Criterios de aceptación (12 pasos del golden path)

Detallados en el PRP — sección *Validation Loop, Level 3*. Resumen:

- [ ] Abrir 2+ sesiones en tabs paralelos, scrollback independiente.
- [ ] Cambiar de tab NO mata ni reinicia PTYs.
- [ ] Input en tab A no aparece en tab B.
- [ ] Cerrar tab activo → se activa el anterior.
- [ ] Cerrar último tab → placeholder visible.
- [ ] Click en sesión ya abierta → activa tab existente, no duplica PTY.
- [ ] Resize de ventana respeta ambos tabs (refit al activar).
- [ ] Cambiar de proyecto mata todos los tabs del anterior.
- [ ] Cerrar+reabrir app → auto-resume sólo de la última sesión activa.
- [ ] `lastSessionId` referenciando un JSONL borrado → no crashea, fallback limpio.
- [ ] Regresión Sprint 01 (WebGL, unicode11, Cmd+C/V/K) OK.

Validación automatizada:

- [ ] `bun run typecheck` limpio.
- [ ] `cargo check` + `cargo clippy -- -D warnings` limpios.

## Limitaciones conocidas (documentar en results)

- **Tabs "new" no se correlacionan con el sidebar** hasta que Sprint 03 añada el watcher de JSONL. El label queda "Nueva sesión" y no aparece indicador en el sidebar para ellos.
- **No hay keyboard shortcuts** (Cmd+T/W/1-9) — Sprint 04.
- **No hay reorder de tabs** — Sprint 04.
- **Persistencia sólo de la última sesión activa**, no de toda la lista de tabs — decisión deliberada.

## Estimación

2–3 días de trabajo. Riesgo principal: patrón de visibility-toggle + refit cuando el tab vuelve a ser visible (requiere cuidado con FitAddon/WebGL).

## Siguiente después de Sprint 02

**Sprint 03** — file tree básico + `notify` watcher (resuelve la correlación de tabs "new" con sessionIds descubiertos en tiempo real).
