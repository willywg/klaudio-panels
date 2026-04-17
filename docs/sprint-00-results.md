# Sprint 01 — Resultados de la PoC

> **Fecha:** 2026-04-16
> **Commit probado:** (llenar al correr)
> **Binario claude:** `/Users/willywg/.local/bin/claude` v2.1.112
> **Plataforma:** macOS (Darwin 25.3.0)
> **Estado:** ⏳ pendiente de validación manual del usuario

## Cómo correr la validación

```bash
bun tauri dev
```

Primer build de Rust ~3–5 min en frío. Después HMR es instantáneo.

Abre **devtools** en la ventana (Cmd+Option+I) antes de empezar; los eventos stream-json se logean ahí si algo falla.

## User flow — 9 pasos

Marca conforme avanzas. Si algo falla, anota en el bloque de *Bugs*.

- [ ] **1.** La ventana abre sin warnings rojos en consola de Tauri/Vite.
- [ ] **2.** Veo la pantalla inicial con el botón **"Abrir proyecto…"**. Click → dialog nativo → elijo una carpeta con sesiones previas (sugerencia: `/Users/willywg/proyectos/construct-ai/copilot-agent` tiene 5 sesiones).
- [ ] **3.** La UI cambia a layout de dos columnas. La izquierda muestra el proyecto + lista de sesiones previas con fecha y preview. La derecha muestra header vacío + input.
- [ ] **4.** Click en **"+ Nueva sesión"** → la derecha queda lista, header dice `— · idle`.
- [ ] **5.** Escribo un prompt corto (ej. `hola, lista los archivos en este repo`) y envío con ⌘+Enter o click Enviar.
- [ ] **6.** Observo en orden:
  - Mi mensaje aparece inmediatamente en índigo.
  - Status cambia a `running`.
  - Header muestra session id real (8 chars + …).
  - Línea `init` con `cwd=...` y `model=sonnet` (o el que llegue).
  - Una o más tarjetas `Bash`/`Read`/`Glob`/etc. con su input y luego su result.
  - Mensaje del assistant con la respuesta.
  - Línea final `done · $0.00xx · Xs`.
  - Status vuelve a `idle`.
- [ ] **7.** Cmd+R (reload): mismo proyecto recordado, misma lista de sesiones. La sesión recién creada **aparece arriba** con preview de mi prompt.
- [ ] **8.** Click en esa sesión → chat se limpia. Escribo `y cuántos archivos eran?` → Claude responde con contexto de la conversación anterior (el `--resume <id>` funciona).
- [ ] **9.** Mientras un turno está corriendo (status=`running`), click **Cancelar** → el botón desaparece y status vuelve a `idle`. En terminal externa: `ps aux | grep -v grep | grep "claude -p"` no muestra nada.

## Métricas a capturar

- **Primer evento** (send → aparece `init` o `hook_started` en UI): ___ ms
- **Primer token de assistant** (send → primer `assistant_text`): ___ s
- **LOC** (llenar corriendo `cloc src src-tauri/src --exclude-dir=target`):
  - Rust: ___
  - TypeScript/TSX: ___
- **Warnings** `cargo clippy -- -D warnings`: ___
- **Warnings** `bun run typecheck`: ___

## Bugs encontrados

> Formato: impacto, pasos para reproducir, stack/log si aplica.

- [ ] (ninguno por ahora)

## Decisiones confirmadas

- [ ] Stream-json funciona como canal primario dentro de Tauri v2.
- [ ] `~/.claude/projects/` es parseable sin inventar storage propio.
- [ ] `--resume <session_id>` mantiene contexto entre turnos.
- [ ] `process-wrap` no fue necesario en la PoC — `kill_on_drop` + `Child::kill()` bastaron para un proceso single-child. Reevaluar cuando Claude lance subshells con Bash.

## Gaps conocidos (scope para Sprint 02)

1. **Sesiones continuadas abren chat vacío.** `list_session_entries` está implementado pero no se usa al hacer `onSelect`. En Sprint 02, al seleccionar una sesión se deberían rehidratar los eventos en la timeline.
2. **stderr solo va a devtools console.** Si `claude` falla por auth o model inválido, el usuario no lo ve en la UI. Agregar toast o banner.
3. **Model picker hardcodeado (`sonnet`).** Sprint 02 debería leer modelos disponibles de algún lado y permitir switch.
4. **Sin markdown rendering.** `assistant_text` se muestra como texto plano (`whitespace-pre-wrap`). Sprint 02: `marked` + `shiki`.
5. **Sin syntax highlighting en tool input/result.** JSON pretty solamente.
6. **Sin indicador visual de streaming.** El mensaje del assistant aparece de golpe cuando llega el evento, no token-por-token (limitación del stream-json que emite bloques completos).
7. **Sin persistencia del último `activeSessionId`** (solo del proyecto). Esto es intencional — el reload arranca "limpio" para evitar rehidratar algo que aún no sabemos mostrar bien.

## Siguiente sprint (borrador)

1. Rehidratar histórico al abrir sesión existente (`list_session_entries` → timeline).
2. Markdown + syntax highlight para assistant text y tool results.
3. Model picker + persistencia de última selección.
4. Toast / banner para errores de `stderr`.
5. Empezar Fase 2 de PROJECT.md: file tree + file viewer.

## Veredicto (llenar al final)

- [ ] **APROBADA** — 9/9 pasos, procedemos con Sprint 02
- [ ] **APROBADA con cambios** — describe ajustes necesarios
- [ ] **BLOQUEADA** — describe el problema y plan

Tag `v0.0.1-poc` al aprobar:

```bash
git tag -a v0.0.1-poc -m "PoC de Claude Code en Tauri aprobada"
```
