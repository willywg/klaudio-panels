# Sprint 01 — Resultados (Claude en PTY)

> **Fecha:** 2026-04-16
> **Branch:** `sprint-01-pty`
> **Tag al merge:** `v0.1.0-pty`
> **Veredicto:** ✅ **APROBADA** — procedemos a Sprint 02.

## Qué se validó

`claude` corre **interactivo en un PTY** (`portable-pty`) dentro de la ventana Tauri; xterm.js renderiza el TUI real sin ningún parsing de la app. El usuario confirmó que el flujo end-to-end funciona correctamente.

## Los 9 pasos

- [x] `bun tauri dev` abre ventana sin warnings.
- [x] Elijo un proyecto con sesiones previas → sidebar muestra la lista.
- [x] Layout 2-col con terminal vacío a la derecha.
- [x] Click **"+ Nueva sesión"** → aparece el TUI de Claude Code v2.1.112 con greeting.
- [x] Escribo prompt y Claude responde con formato nativo (colores, markdown, tool cards).
- [x] Ctrl+C interrumpe turno (default de xterm).
- [x] Resize de ventana re-acomoda el TUI (pty_resize + FitAddon).
- [x] Click en sesión vieja → PTY actual muere, `claude --resume <id>` muestra historial real.
- [x] Cmd+C / Cmd+V / Cmd+K funcionan como se espera.

## Problemas detectados en la primera corrida y resueltos

| # | Síntoma | Causa | Fix aplicado |
|---|---------|-------|---------------|
| 1 | Scrollbars externos horizontal y vertical sobre xterm | Capas del webview permitían overflow por fuera del control interno de xterm | `overflow-hidden` + `min-w/h-0` en `<main>`, grid, aside, section y container |
| 2 | Delay sin feedback entre click "+ Nueva sesión" y primer byte del PTY | No había estado intermedio entre el invoke y el primer `pty:data` | Signal `opening`, `<LoadingPanel>` con spinner + "Iniciando Claude Code…" |
| 3 | Icono ASCII-art de Claude desfasado / con fantasma entre celdas | `lineHeight: 1.2` + renderer canvas default miscalculaban ancho de box-drawing y emojis | `lineHeight: 1.0`, `@xterm/addon-unicode11` (`activeVersion = "11"`), `@xterm/addon-webgl` con fallback a canvas |

## Métricas

- **LOC Rust** (`src-tauri/src/*.rs`): 657
- **LOC TypeScript/TSX** (`src/**/*`): 557
- **Commits del sprint:** 7
- **Tiempo real:** ~1 día efectivo (más corto que el estimado de 2–4 días — la base que sobrevivió de Sprint 00 ayudó mucho)

## Qué sobrevivió de Sprint 00

- `src-tauri/src/binary.rs` — detección de `claude` vía `which` + fallbacks
- `src-tauri/src/sessions.rs` — parser de `~/.claude/projects/**/*.jsonl`
- Scaffold Tauri + SolidJS + Tailwind v4
- `ProjectPicker`, `SessionsList`, layout 2-column, localStorage

## Qué se agregó en este sprint

- `src-tauri/src/shell_env.rs` — probe/load/merge del env del login shell (port directo de OpenCode). Crítico para que `Bash`/`git`/`rg`/`node` funcionen dentro de Claude en macOS GUI.
- `src-tauri/src/pty.rs` — `portable-pty` con `pty_open/write/resize/kill`, lectura en `spawn_blocking`, emit `pty:data:<id>` y `pty:exit:<id>` vía base64.
- `src/context/terminal.tsx` — store single-PTY con pub/sub para `onData`/`onExit`.
- `src/components/terminal-view.tsx` — xterm.js con FitAddon, Unicode11Addon, WebGL, WebLinks, keybinds custom.
- Wiring en `App.tsx`: sesiones `--resume <id>`, "+ Nueva sesión" sin args, cambio de proyecto mata PTY.

## Decisiones confirmadas por la validación

- **PTY puro > parsing stream-json.** El TUI real funciona sin fricción; el usuario obtiene 100% de las features del CLI.
- **Shell env hydration es obligatorio.** Sin `probe_shell_env`, Claude no encontraría `node`/`git`/etc. Funcionó al primer intento.
- **base64 para bytes PTY ↔ frontend.** Tauri serializa payload como string; base64 es el transporte robusto.
- **WebGL renderer + Unicode 11 es no-negociable** para el TUI de Claude (iconos ASCII-art, progress bars, glyphs Warp).

## Sprint 02 — Próximo

Backlog inmediato (decidir prioridad en kickoff):

1. **Multi-tab de sesiones** — varios PTYs concurrentes con tabs, cada uno con su propio xterm.
2. **File tree básico** — lateral navegación lazy + `notify` watcher (Fase 2 de `PROJECT.md`).
3. **Persistir última sesión activa por proyecto** — al reabrir, auto-resume.
4. **SQLite de app settings** — primeras entradas: proyectos favoritos, last session id, window size.

Open questions para Sprint 02:
- ¿Multi-tab como pestañas (browser-style) o como lista en sidebar con múltiples checkmark?
- ¿File tree como panel adicional colapsable, o reemplaza la sidebar de sesiones?
