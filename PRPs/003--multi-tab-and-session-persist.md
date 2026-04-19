# PRP 003 — Multi-tab de sesiones + persistencia de última sesión

> **Version:** 1.0
> **Created:** 2026-04-17
> **Status:** Ready
> **Phase:** Sprint 02 (PROJECT.md Fase 1.5 — multi-sesión)

---

## Goal

El usuario puede abrir **varias sesiones de Claude Code simultáneamente** dentro de la misma ventana, cada una en su propio tab con su propio PTY independiente. Los tabs viven sobre el terminal (estilo navegador/iTerm): `[sesión A] [sesión B] [+]`. Cambiar de tab conmuta instantáneamente la vista sin perder scrollback ni matar el proceso. Cerrar un tab mata sólo ese PTY. Al reabrir un proyecto, la app **auto-resumea la última sesión activa** del usuario para ese proyecto (persistida en `localStorage`).

## Why

- **Multi-tab** es la UX esperada de cualquier IDE/terminal moderno. Sin esto, el usuario debe elegir entre trabajar en una conversación u otra — pero Claude Code se presta a tener varias conversaciones vivas (una para código, otra para docs, otra para experimentar).
- **Persistencia de última sesión** elimina la fricción del "¿cuál estaba usando?" al reabrir la app. Es el 80% del valor de la persistencia completa de estado con 20% del esfuerzo.
- Ambas tareas tocan el mismo estado (qué sesión está abierta, dónde) — hacerlo junto evita rediseñar `TerminalContext` dos veces.
- Backend Rust ya soporta N PTYs concurrentes (`HashMap<id, PtySession>` en `pty.rs`). **El trabajo es casi 100% frontend + state management.**

## What

### User-visible behavior

1. En el panel derecho, sobre el terminal, aparece una **tab strip** con las sesiones abiertas.
2. Click en "+ Nueva sesión" en el sidebar → se abre en un **tab nuevo** (no reemplaza el activo).
3. Click en una sesión del sidebar:
   - Si ya hay un tab abierto con `--resume <id>` para esa sesión → **activar** ese tab existente.
   - Si no → abrir un **tab nuevo** con `--resume <id>`.
4. Click en un tab → conmuta a esa sesión. Scrollback y estado del TUI intactos.
5. Click en la "×" de un tab → mata sólo ese PTY. Si era el activo, se activa el tab anterior. Si era el último, se muestra el placeholder de "elige una sesión".
6. En el sidebar, las sesiones abiertas muestran un **indicador visual** (punto verde / borde lateral).
7. Al reabrir el proyecto (o al arrancar la app con `projectPath` persistido), se **auto-spawnea un tab** haciendo `claude --resume <lastSessionId>`. Si falla (sesión borrada), se hace fallback silencioso al placeholder.

### Success Criteria

- [ ] Abrir 2+ sesiones en tabs paralelos, cada una mantiene scrollback propio al conmutar.
- [ ] Cambiar de tab no mata ningún PTY ni reinicia el TUI (verificar con `ps` que ambos `claude` siguen vivos).
- [ ] Escribir input en tab A no aparece en tab B.
- [ ] Cerrar el tab activo conmuta al tab anterior sin error.
- [ ] Cerrar el último tab vuelve al placeholder "elige una sesión".
- [ ] Click en sesión del sidebar que ya está abierta en tab no spawnea un segundo PTY (activa el existente).
- [ ] Cerrar la app con una sesión abierta, reabrir → esa sesión (o la última activa) aparece auto-resumida en un tab.
- [ ] `lastSessionId` borrada del filesystem no rompe el arranque (fallback a placeholder).
- [ ] `typecheck` + `cargo check` + `cargo clippy -- -D warnings` limpios.
- [ ] Sin regresión: una sola sesión sigue funcionando idéntico a Sprint 01 (xterm WebGL, FitAddon, clipboard, unicode11).

---

## All Needed Context

### Project-level references (always relevant)

```yaml
- file: PROJECT.md
  why: Blueprint, especialmente sección "Fase 1.5 multi-sesión" y "Fase 4 app settings".
- file: CLAUDE.md
  why: Reglas inamovibles. La línea 9 ("Single PTY per window in Sprint 01") debe ACTUALIZARSE como parte de este PRP.
- file: docs/sprint-01-results.md
  why: Backlog que alimenta este sprint.
```

### Feature-specific references

```yaml
# Propio — trabajo previo reutilizable
- file: src-tauri/src/pty.rs
  why: Ya soporta N PTYs concurrentes vía `PtyState { sessions: Mutex<HashMap<String, PtySession>> }`. NO TOCAR salvo correcciones.
  lines: 17-19, 26-133

- file: src/context/terminal.tsx
  why: Punto de refactor principal — pasa de single-id store a tabs collection.
  lines: 23-119

- file: src/components/terminal-view.tsx
  why: Debe aceptar `id` prop (tab id) en lugar de leer `ctx.store.id`. Múltiples instancias coexistirán.
  lines: 37-162

- file: src/App.tsx
  why: Layout principal. Añade tab strip + overlay de N TerminalViews con visibility toggle.
  lines: 50-104

# OpenCode — patrón de referencia
- file: ~/proyectos/open-source/opencode/packages/app/src/pages/session/terminal-panel.tsx
  why: Muestra cómo mantienen múltiples terminales montados y conmutan visibilidad. Estructura del componente tab + panel.
  note: Ellos usan ghostty-web, nosotros xterm.js — el patrón de mount/show aplica igual.

- file: ~/proyectos/open-source/opencode/packages/app/src/context/terminal.tsx
  why: Cómo modelan "terminal state por id" vs "active id".
```

### Current repo state (relevant portions)

```
src/
├── App.tsx                       # Shell, grid [sidebar | section]
├── context/terminal.tsx          # Single-id store (REFACTOR)
├── components/
│   ├── terminal-view.tsx         # Lee ctx.store.id (REFACTOR: prop-based)
│   ├── sessions-list.tsx         # Sidebar con sesiones del JSONL
│   └── project-picker.tsx        # Folder picker
src-tauri/src/
├── pty.rs                        # Multi-PTY ya soportado
├── sessions.rs                   # read-only de ~/.claude/projects/
├── binary.rs, shell_env.rs
```

### Desired changes

```
src/
├── App.tsx                              # MODIFY: renderiza tab strip + N terminals overlapped
├── context/terminal.tsx                 # REWRITE: tabs map + activeTabId
├── components/
│   ├── terminal-view.tsx                # MODIFY: acepta `id` prop; `ctx.get(id)` en vez de `ctx.store`
│   ├── tab-strip.tsx                    # NEW: fila horizontal de tabs + botón +
│   ├── sessions-list.tsx                # MODIFY: indicador de "abierta en tab" por sessionId
│   └── last-session.ts                  # NEW (pequeño): helpers localStorage para lastSessionId
```

### Known gotchas & project rules

```
CRITICAL — xterm.js persistence across tab switches:
  - NO destruir `Terminal` instance al cambiar de tab → perderías scrollback.
  - NO usar `display: none` → rompe FitAddon (no puede medir celdas en elementos ocultos)
    y WebGL (el canvas queda congelado).
  - PATRÓN CORRECTO: todos los TerminalView montados simultáneamente, apilados con
    `position: absolute; inset: 0;` dentro de un contenedor `relative`. Conmutar con
    `z-index` + `visibility: hidden/visible` + `pointer-events: none/auto`.
  - Al reactivar un tab, llamar `fit?.fit()` después del siguiente frame para recalcular
    si la ventana cambió de tamaño mientras estaba oculto.

CRITICAL — Tab id ≠ Session id:
  - El tab id es el PTY UUID (lo que devuelve `pty_open`). Estable de por vida del tab.
  - El session id sólo existe para tabs con `--resume <id>`. Tabs "new" NO tienen session
    id asociado hasta que Claude escriba el JSONL (discovery vía watcher = Sprint 03).
  - NO intentes correlacionar tabs "new" con sesiones del sidebar en este sprint.
    Queda documentado como limitación conocida.

CRITICAL — Semántica de click en sidebar:
  - Click en sesión X del sidebar:
      → existe tab con sessionId === X  → activar ese tab.
      → no existe                       → abrir tab nuevo con `claude --resume X`.
  - NUNCA reemplazar el tab activo al hacer click en sidebar (rompe la expectativa de
    independencia de los tabs).

CRITICAL — Persistencia mínima:
  - Solo `localStorage.setItem("lastSessionId:<projectPath>", sessionId)` al activar un
    tab con sessionId definido.
  - NO persistir la lista completa de tabs abiertos (re-spawn de N PTYs al arrancar = UX
    impredecible + puede colgarse si hay N>3).
  - Al cargar el proyecto: leer key, si hay valor → spawn un solo tab con `--resume`. Si
    falla (PTY exit con código ≠ 0 en <2s o `claude` escribe "No such session"), limpiar
    la key y volver al placeholder.

LIBRARY QUIRKS:
  - xterm @6 FitAddon: `fit()` requiere que el container sea visible (getBoundingClientRect
    con size > 0). Si el tab está oculto cuando se dispara ResizeObserver, el fit debe
    deferirse al momento en que el tab vuelve a ser visible.
  - SolidJS createStore: mutaciones sobre sub-paths anidados requieren el DSL de producer
    o path-based setStore. Para tabs[] usar `setStore("tabs", tabs.length, newTab)`
    o `setStore(produce((s) => { s.tabs.push(newTab) }))`.
  - Tauri listener: cada tab necesita su propio `listen<string>(pty:data:<id>, ...)`.
    Hay que trackear unlistenFns por tab id y llamarlas al cerrar.

NO-GOES (fuera de scope de este PRP, irán a Sprint 04):
  - Keyboard shortcuts (Cmd+T nuevo tab, Cmd+W cerrar, Cmd+1-9 activar, Cmd+Shift+[/] ciclar).
  - Reordenar tabs con drag & drop.
  - Límite configurable de tabs abiertos.
  - SQLite (localStorage es suficiente para este PRP).
  - Multi-ventana (una sola ventana con N tabs por ahora).
```

---

## Implementation Blueprint

### Data models / types

```ts
// src/context/terminal.tsx
export type TabStatus = "running" | "exited" | "error";

export type TerminalTab = {
  id: string;                    // PTY UUID — identidad estable del tab
  projectPath: string;           // cwd del PTY
  sessionId: string | null;      // null para tabs "new" (hasta Sprint 03)
  label: string;                 // "Nueva sesión" o preview de la sesión resumida
  status: TabStatus;
  exitCode: number | null;
  error: string | null;
};

type TerminalStore = {
  tabs: TerminalTab[];
  activeTabId: string | null;
};

type DataHandler = (bytes: Uint8Array) => void;
type ExitHandler = (code: number) => void;
```

```ts
// src/components/last-session.ts
export function lastSessionKey(projectPath: string): string {
  return `lastSessionId:${projectPath}`;
}

export function getLastSessionId(projectPath: string): string | null {
  return localStorage.getItem(lastSessionKey(projectPath));
}

export function setLastSessionId(projectPath: string, sessionId: string | null): void {
  const k = lastSessionKey(projectPath);
  if (sessionId) localStorage.setItem(k, sessionId);
  else localStorage.removeItem(k);
}
```

### Tasks (in execution order)

```yaml
Task 1: Refactor TerminalContext → tabs collection
  FILE: src/context/terminal.tsx
  REWRITE:
    - Store: { tabs: TerminalTab[], activeTabId: string | null }
    - Por-tab: unlistenFns (Map<id, { data: UnlistenFn, exit: UnlistenFn }>)
    - Por-tab: handler sets (Map<id, Set<DataHandler>>, Map<id, Set<ExitHandler>>)
  API:
    - openTab(projectPath, args, opts: { label, sessionId }): Promise<string>
    - closeTab(id): Promise<void>
    - setActiveTab(id): void
    - write(id, bytes): Promise<void>
    - resize(id, cols, rows): Promise<void>
    - onData(id, handler): () => void      // per-tab subscription
    - onExit(id, handler): () => void
    - getTab(id): TerminalTab | undefined
  CLEANUP:
    - onCleanup: kill all tabs
  DO NOT: emitter global ctx.store.id — cada TerminalView debe pedir SU tab.

Task 2: TerminalView acepta `id` prop
  FILE: src/components/terminal-view.tsx
  MODIFY:
    - props: { id: string }
    - onMount: ctx.onData(props.id, ...) / ctx.onExit(props.id, ...)
    - onData handler del xterm: void ctx.write(props.id, bytes)
    - onResize handler: void ctx.resize(props.id, cols, rows)
    - onCleanup: unsubscribe + dispose xterm (NO ctx.kill — el tab vive aunque el
      TerminalView se desmonte por cambio de proyecto)
  FIT:
    - Expose un método `refit()` via ref o cb props, llamable cuando el tab vuelve a ser
      visible (ver Task 4). Internamente: requestAnimationFrame → fit.fit().

Task 3: TabStrip component
  FILE: src/components/tab-strip.tsx (NEW)
  API:
    - props: {
        tabs: TerminalTab[],
        activeTabId: string | null,
        onActivate: (id: string) => void,
        onClose: (id: string) => void,
        onNew: () => void,
      }
  UI:
    - Fila horizontal, altura ~32px, border-b.
    - Cada tab: label truncado (~24ch) + dot de status (verde running, gris exited,
      rojo error) + botón × (aparece en hover o si es el activo).
    - Botón `[+]` al final.
    - Overflow: scroll horizontal cuando hay muchos tabs (overflow-x-auto).
  ESTILO: Tailwind v4; seguir la paleta dark existente (neutral-8xx).

Task 4: App.tsx — overlay de N TerminalViews
  FILE: src/App.tsx
  STRUCTURE:
    <section>
      <TabStrip ... />
      <div class="relative flex-1 min-h-0">
        <For each={tabs}>{(tab) =>
          <div
            class="absolute inset-0"
            style={{
              visibility: tab.id === activeTabId ? "visible" : "hidden",
              "pointer-events": tab.id === activeTabId ? "auto" : "none",
              "z-index": tab.id === activeTabId ? 1 : 0,
            }}
          >
            <TerminalView id={tab.id} />
          </div>
        }</For>
        <Show when={tabs.length === 0}>
          <Placeholder />
        </Show>
      </div>
    </section>
  CRITICAL:
    - createEffect: cuando cambia activeTabId, esperar un frame y llamar refit() del tab
      nuevo (la reactivación puede requerir re-medir si la ventana cambió de tamaño
      mientras estaba oculto).

Task 5: Handlers de sessions-list + "new" + close
  FILE: src/App.tsx
  LOGIC:
    - handleNew(): term.openTab(projectPath, [], { label: "Nueva sesión", sessionId: null })
      → setActiveTab al nuevo id.
    - handleSelect(sessionId): si existe tab con sessionId === X → setActiveTab(tab.id).
      Si no → openTab(projectPath, ["--resume", sessionId], { label: preview, sessionId }).
    - handleCloseTab(id): await term.closeTab(id). Si quedan tabs y era activo →
      activar el anterior. Si no → setActiveTab(null).
    - createEffect: cuando activeTab.sessionId cambia, setLastSessionId(projectPath, sid).
    - createEffect: al cambiar projectPath, killall + setLastSessionId-for-old-project ya
      está guardado. NO auto-spawn aquí — lo hace el onMount inicial.

Task 6: Auto-resume al arrancar
  FILE: src/App.tsx
  LOGIC:
    - onMount: si projectPath existe y getLastSessionId(projectPath) tiene valor →
      intenta openTab con ["--resume", lastId]. Si onExit dispara con código ≠ 0 en <2s,
      considerarlo un fail: setLastSessionId(projectPath, null), closeTab, mostrar toast
      silencioso (console.info por ahora; toast UI es out-of-scope).

Task 7: Sidebar — indicador de "abierta en tab"
  FILE: src/components/sessions-list.tsx
  ADD prop: openSessionIds: Set<string>
  RENDER:
    - Si session.id ∈ openSessionIds: añadir dot verde a la izquierda, class "border-l-green-500"
      (sin pisar el border activo que ya pinta indigo).
    - El activo del tab strip no es necesariamente el "activo" visible en sidebar — el
      sidebar pinta el sessionId del tab activo como "activo" (coherente con Sprint 01).

Task 8: Actualizar CLAUDE.md regla #9
  FILE: CLAUDE.md
  MODIFY línea 9:
    antes: "Single PTY per window in Sprint 01. Switching session kills the current
           child and spawns a new one. Multi-tab is Sprint 02; don't pre-build state for it."
    después: "Multi-PTY por ventana con tabs (Sprint 02+). Cada tab es un child
             independiente. Cerrar tab mata sólo ese PTY. Cambio de tab conmuta
             visibilidad (nunca re-crea xterm). Última sesión activa por proyecto se
             persiste en localStorage; auto-resume al reabrir."
```

### Pseudocódigo (detalles críticos)

```ts
// src/context/terminal.tsx — esqueleto del refactor
export function makeTerminalContext() {
  const [store, setStore] = createStore<TerminalStore>({ tabs: [], activeTabId: null });

  const unlistens = new Map<string, { data: UnlistenFn; exit: UnlistenFn }>();
  const dataHandlers = new Map<string, Set<DataHandler>>();
  const exitHandlers = new Map<string, Set<ExitHandler>>();

  async function attachListeners(id: string) {
    const dUn = await listen<string>(`pty:data:${id}`, (e) => {
      const bytes = base64ToBytes(e.payload);
      const set = dataHandlers.get(id);
      if (set) for (const h of set) h(bytes);
    });
    const xUn = await listen<number>(`pty:exit:${id}`, (e) => {
      setStore(
        "tabs",
        (t) => t.id === id,
        produce((tab) => {
          tab.status = "exited";
          tab.exitCode = e.payload;
        }),
      );
      const set = exitHandlers.get(id);
      if (set) for (const h of set) h(e.payload);
    });
    unlistens.set(id, { data: dUn, exit: xUn });
  }

  async function openTab(
    projectPath: string,
    args: string[],
    opts: { label: string; sessionId: string | null },
  ): Promise<string> {
    const id = (await invoke("pty_open", { projectPath, args })) as string;
    const tab: TerminalTab = {
      id,
      projectPath,
      sessionId: opts.sessionId,
      label: opts.label,
      status: "running",
      exitCode: null,
      error: null,
    };
    setStore(produce((s) => {
      s.tabs.push(tab);
      s.activeTabId = id;
    }));
    await attachListeners(id);
    return id;
  }

  async function closeTab(id: string): Promise<void> {
    try { await invoke("pty_kill", { id }); } catch { /* ignore */ }
    const un = unlistens.get(id);
    if (un) { un.data(); un.exit(); unlistens.delete(id); }
    dataHandlers.delete(id);
    exitHandlers.delete(id);
    setStore(produce((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx >= 0) s.tabs.splice(idx, 1);
      if (s.activeTabId === id) {
        s.activeTabId = s.tabs.length > 0 ? s.tabs[Math.max(0, idx - 1)].id : null;
      }
    }));
  }
  // write/resize/onData/onExit similar, pero siempre reciben id
  // onCleanup: for (const id of [...unlistens.keys()]) await closeTab(id)
}
```

```tsx
// src/App.tsx — overlay pattern (simplificado)
<div class="relative flex-1 min-h-0">
  <For each={term.store.tabs}>
    {(tab) => {
      const isActive = () => tab.id === term.store.activeTabId;
      return (
        <div
          class="absolute inset-0 flex flex-col"
          style={{
            visibility: isActive() ? "visible" : "hidden",
            "pointer-events": isActive() ? "auto" : "none",
          }}
        >
          <TerminalView id={tab.id} />
        </div>
      );
    }}
  </For>
  <Show when={term.store.tabs.length === 0}>
    <Placeholder />
  </Show>
</div>
```

---

## Validation Loop

### Level 1: Syntax & style

```bash
bun run typecheck
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
```

Rust debería pasar sin cambios (no tocamos backend salvo si se encuentra un bug durante la integración).

### Level 2: Unit tests

Pocos — este sprint es casi 100% UI/state. Candidatos:

- `context/terminal.test.ts` (si se decide añadir vitest — no existe todavía): unidad sobre `openTab` → store.tabs.length === 1 y activeTabId correcto; `closeTab` activo → activa el anterior.
- No añadir vitest sólo por esto si no existe — defer a Sprint 04.

### Level 3: Integration / manual (golden path completo)

```bash
bun tauri dev
```

Pasos (todos deben pasar):

1. **Abrir proyecto** que tenga 2+ sesiones en `~/.claude/projects/`. Ver que auto-resume la última usada (si hay `lastSessionId`). Si es primer arranque, placeholder visible.
2. **Click "+ Nueva sesión"** → aparece tab nuevo, activo. Terminal muestra el welcome de Claude Code.
3. **Click otra sesión del sidebar** → se abre un segundo tab con `--resume`. El anterior no se mata (verificar con `ps aux | grep claude` → 2 procesos).
4. **Escribir en tab B, cambiar a A** → el input sólo aparece en B. El contenido de A sigue intacto, scrollback completo.
5. **Generar scroll en A** (varios comandos), cambiar a B, volver a A → scrollback de A intacto.
6. **Click en sesión X del sidebar que ya está abierta como tab** → se activa ese tab, NO se spawnea un tercer PTY (`ps` sigue mostrando 2).
7. **Resize de la ventana** estando en tab A → tab A se adapta. Cambiar a B → B también se adapta (refit on activate).
8. **Cerrar tab activo** con × → se activa el anterior, PTY de B muere (`ps` → 1 proceso).
9. **Cerrar el último tab** → placeholder visible. `ps` → 0 claudes.
10. **Cambiar de proyecto** → todos los tabs mueren. El nuevo proyecto muestra su propio `lastSessionId` (o placeholder si no hay).
11. **Cerrar y reabrir la app** con un proyecto con tabs abiertos → auto-resume sólo la última sesión activa (no todos los tabs — es la decisión documentada).
12. **Borrar manualmente** `~/.claude/projects/<encoded>/<lastSessionId>.jsonl` y reabrir la app → no crashea; fallback limpio al placeholder + key borrada.

Regresión Sprint 01 (debe seguir funcionando):

- [ ] WebGL activo, unicode11 activo (icon de Claude renderiza correctamente).
- [ ] Cmd+C/V/K siguen funcionando en el tab activo.
- [ ] `bun tauri dev` arranca sin warnings nuevos en consola.

---

## Final Checklist

- [ ] `bun run typecheck` limpio
- [ ] `cargo check` + `cargo clippy -- -D warnings` limpios
- [ ] 12 pasos de integración manual pasan
- [ ] CLAUDE.md regla #9 actualizada
- [ ] PROJECT.md: agregar Sprint 02 a la tabla de estado como "done" cuando se cierre
- [ ] `docs/sprint-02-results.md` creado con: LOC, PTYs concurrentes validados, limitaciones conocidas (new-tab no indexado en sidebar hasta Sprint 03)

---

## Anti-Patterns to Avoid

- ❌ **`display: none`** para ocultar tabs inactivos → rompe FitAddon y WebGL.
- ❌ **Destruir `Terminal` instance** al cambiar de tab → pierde scrollback; usar visibility toggle.
- ❌ **Correlacionar tabs "new" con sesiones del sidebar** → requiere JSONL watcher, Sprint 03.
- ❌ **Persistir la lista completa de tabs** abiertos → scope creep + UX impredecible al arrancar.
- ❌ **SQLite en este sprint** → localStorage es suficiente; SQLite es Sprint 03/04.
- ❌ **Keyboard shortcuts** (Cmd+T/W/1-9) → fuera de scope.
- ❌ **Reemplazar el tab activo** al hacer click en sidebar → rompe la independencia esperada.
- ❌ **Spawn paralelo de N PTYs al arrancar** desde persistencia → sólo `lastSessionId`.
- ❌ **Llamar `ctx.kill()` en `onCleanup` de TerminalView** → desmontar la vista NO debe matar el PTY (el tab puede estar montado/oculto).

---

## Notes

**Decisión de diseño — tab strip sobre el terminal (opción A, elegida por el usuario):**
Tabs estilo navegador/iTerm arriba del terminal. Rechazado: indicadores en sidebar (opción B) — los tabs son el patrón universal para "múltiples instancias del mismo tipo" y la sidebar ya está cargada con histórico + botones.

**Limitación conocida — tabs "new" sin sessionId correlacionado:**
Al crear un tab nuevo (`claude` sin `--resume`), no conocemos su sessionId real hasta que Claude escriba el JSONL. En este sprint el tab vive con `sessionId: null` y su label queda "Nueva sesión". El sidebar no lo marcará como abierto (no puede: sólo conoce ids del JSONL). Sprint 03 añadirá el watcher de JSONL que permitirá hacer el match a posteriori.

**Follow-ups para Sprint 04 (anotar al cierre):**
- Keyboard shortcuts estándar (Cmd+T/W/1-9, ciclado).
- Reorder con drag & drop.
- Migrar `lastSessionId` a SQLite junto con otras app settings.
- Toast UI para fallos silenciosos (ej. `--resume` a sesión borrada).

**Confidence para one-pass success: 8/10.** Backend ya preparado (multi-PTY), refactor del contexto es mecánico pero requiere cuidado con la semántica de handlers por-id y el pattern de visibility toggle.
