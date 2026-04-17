# Claude Desktop — Project Blueprint

> Ventana nativa que **embebe Claude Code corriendo en PTY**, con sidebar de proyectos/sesiones y (más adelante) file tree, diff viewer y terminal libre.

## Objetivo

App de escritorio construida con Tauri v2 + SolidJS que **muestra el TUI real de Claude Code** dentro de un panel de la ventana, sin reimplementar su UI ni parsear su output. El usuario obtiene todo el CLI gratis (slash commands, permisos interactivos, `-r` picker, autocomplete, hooks) y la app agrega UX alrededor:

1. **Terminal central con Claude Code** — `claude` nativo corriendo en PTY; xterm.js renderiza bytes tal cual.
2. **Sidebar de proyectos y sesiones** — selector de carpeta + lista de sesiones leídas de `~/.claude/projects/`. Click en sesión → `claude --resume <id>` en el PTY.
3. **File tree** (Fase 2) — lateral, navegación rápida, badges de git status.
4. **Diff viewer** (Fase 3) — panel de revisión basado en `@pierre/diffs`.
5. **Terminal libre adicional** (Fase 4) — tabs extra para shell/otros CLIs.

## Estrategia de Integración — PTY puro

**Claude Code corre como proceso interactivo en PTY.** La app no parsea su output, solo lo renderiza.

```
┌─────────────────────────────────────────────────┐
│  Usuario escribe en xterm.js                    │
│       │ bytes                                    │
│       ▼                                          │
│  Tauri invoke("pty_write", id, bytes)           │
│       │                                          │
│       ▼                                          │
│  portable-pty master.write() → PTY slave        │
│       │                                          │
│       ▼                                          │
│  claude CLI (TUI nativo: colores, cursor, etc.) │
│       │ stdout/stderr                            │
│       ▼                                          │
│  portable-pty master.read() → emit              │
│  event "pty:data:<id>" con bytes                │
│       │                                          │
│       ▼                                          │
│  xterm.js term.write(bytes) → pantalla          │
└─────────────────────────────────────────────────┘
```

**Modos de invocar `claude`** (todos en PTY):

| Acción en la UI                      | Comando                    |
| ------------------------------------ | -------------------------- |
| Click "+ Nueva sesión"               | `claude`                   |
| Click "Continuar última"             | `claude -c`                |
| Click en una sesión de la sidebar    | `claude --resume <id>`     |

### Persistencia de sesiones

**Reutilizamos el storage nativo de Claude Code.** Las sesiones viven en `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`. La app:
- Lee estos JSONL para listar sesiones en la sidebar (timestamp + preview del primer mensaje).
- No escribe nada ahí. No rehidrata mensajes en UI — `claude --resume` lo hace por nosotros dentro del PTY.
- Para settings propios (proyecto activo, window state) usa `localStorage` y, más adelante, SQLite.

## Stack Tecnológico

| Capa                 | Tecnología                              | Justificación                                                  |
| -------------------- | --------------------------------------- | -------------------------------------------------------------- |
| **Shell nativo**     | Tauri v2 (Rust)                         | Binario pequeño, auto-update, IPC rápida                       |
| **Frontend UI**      | SolidJS 1.9                             | Signals + stores, ergonómico                                   |
| **CSS**              | TailwindCSS v4                          | Utility-first                                                  |
| **Componentes**      | Kobalte (headless) + custom             | Accesibles                                                     |
| **Build**            | Vite 7                                  | HMR                                                            |
| **PTY**              | `portable-pty` (Rust) + `xterm.js` (TS) | Spawn interactivo de `claude`, render completo de TUI          |
| **Diff Engine**      | `@pierre/diffs` (Fase 3)                | Motor probado en OpenCode                                      |
| **Syntax Highlight** | Shiki (Fase 2)                          | Grammar lazy loading                                           |
| **Git**              | `git2` (Fase 3)                         | Diff, status, log                                              |
| **File Watching**    | `notify` (Fase 2)                       | Refresco file tree                                             |
| **App state**        | `localStorage` (PoC) → `rusqlite` (F5)  | Settings, proyecto activo                                      |

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri v2 Window (Rust)                                      │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  SolidJS App (webview)                                 │ │
│  │  ┌──────────────┐ ┌─────────────────────────────────┐ │ │
│  │  │  Sidebar     │ │  Terminal (xterm.js)            │ │ │
│  │  │              │ │                                 │ │ │
│  │  │ Projects     │ │  ┌─ renderiza bytes del PTY ─┐ │ │ │
│  │  │ Sessions     │ │  │                            │ │ │ │
│  │  │ (JSONL list) │ │  │   claude > _              │ │ │ │
│  │  │              │ │  │                            │ │ │ │
│  │  │ [+ Nueva]    │ │  └────────────────────────────┘ │ │ │
│  │  └──────────────┘ └─────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Rust Backend (Tauri Commands + Events)                     │
│  ├─ binary.rs   : detectar `claude` en PATH                  │
│  ├─ sessions.rs : listar sesiones de ~/.claude/projects/    │
│  ├─ pty.rs      : portable-pty + shell env hydration        │
│  └─ (fases posteriores)                                      │
│     ├─ fs.rs    : readdir + notify watcher                  │
│     ├─ git.rs   : diff/status via git2                       │
│     └─ config.rs: SQLite settings                            │
└─────────────────────────────────────────────────────────────┘
```

## Layout — Sprint 01 (single-PTY)

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Desktop                            ─ □ ✕          │
├───────────────┬──────────────────────────────────────────────┤
│  Proyecto     │                                              │
│  psicolab     │  $ claude                                    │
│  ← cambiar    │  │ ✻ Claude Code v2.1.112                   │
│               │  │                                            │
│  [+ Nueva]    │  │ Hola! ¿Qué quieres hacer hoy?             │
│               │  │                                            │
│  SESIONES     │  │ > _                                       │
│  7:21pm       │                                              │
│  archivos en… │                                              │
│               │                                              │
│  5:58pm       │                                              │
│  langsmith    │                                              │
│               │                                              │
│  2 abr        │                                              │
│  ssh docker   │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

Un solo PTY activo. Cambiar sesión mata el PTY anterior y spawnea uno nuevo con `--resume <id>`. Multi-tab llega en Sprint 02.

## Estructura del Proyecto

```
claude-desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs              # Tauri setup, registra comandos
│       ├── binary.rs           # Detección de `claude` (reusado de Sprint 00)
│       ├── sessions.rs         # Parseo de ~/.claude/projects (reusado de Sprint 00)
│       ├── pty.rs              # portable-pty + shell env
│       └── shell_env.rs        # probe_shell_env / load_shell_env
│
├── src/
│   ├── App.tsx                 # Layout 2-column
│   ├── index.tsx               # Entry
│   ├── index.css               # Tailwind
│   │
│   ├── context/
│   │   └── terminal.tsx        # PTY activo: id, write, resize, kill
│   │
│   ├── components/
│   │   ├── project-picker.tsx  # Dialog de directorio
│   │   ├── sessions-list.tsx   # Sidebar + "+ Nueva sesión"
│   │   └── terminal-view.tsx   # xterm.js mount + addon-fit + keybinds
│   │
│   └── lib/
│       └── paths.ts            # Helpers path
│
├── package.json
├── vite.config.ts
├── tailwind.config.ts (v4: solo @import)
└── tsconfig.json
```

## File Tree, Diff, File Viewer — Fases posteriores

Estos componentes **se alimentan de filesystem + git, no del PTY**. No hay integración entre Claude Code y la UI fuera del PTY mismo. Cuando Claude edita un archivo, el watcher de `notify` lo detecta, el file tree se refresca, el diff panel se recalcula. La app nunca "mira dentro" del PTY.

Esto mantiene dos disciplinas separadas:
- **Lo que Claude hace** → visible en el TUI nativo.
- **Lo que cambia en el repo** → visible via filesystem/git en paneles propios.

## Referencias del Ecosistema

### OpenCode Desktop (anomalyco/opencode) — referencia principal

Ahora SÍ aplica. OpenCode Desktop es el modelo: ventana nativa con CLI embebido.

| Path de OpenCode                                              | Qué aprender                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/desktop/src-tauri/src/cli.rs` L220-L365             | `probe_shell_env` + `load_shell_env` + `merge_shell_env` — **crítico para nvm/volta/asdf** |
| `packages/app/src/components/terminal.tsx`                    | Integración terminal (ellos usan ghostty-web, nosotros xterm.js, patrón transfiere) |
| `packages/app/src/context/terminal.tsx`                       | Lifecycle, persistencia de buffer, resize                      |
| `packages/app/src/pages/session/terminal-panel.tsx`           | Tabs (para Sprint 02)                                          |

**Qué NO copiar de OpenCode**:
- El patrón sidecar-HTTP de `cli.rs` (arriba de L220) — asume que el CLI es un server con endpoints WebSocket. `claude` no tiene server; spawneamos PTY directo.
- `ghostty-web` — es su fork propio, usamos xterm.js por ser estándar.
- `packages/opencode/`, `packages/sdk/`, `packages/shared/` — su server LLM, irrelevante.

### Claudia (getAsterisk/claudia) — archivo

Referencia del approach descartado (stream-json wrapper). Sirvió en Sprint 00 para validar parser de sesiones y binary detection. Ya no se consulta para arquitectura.

## Plan de Implementación — Fases

### Sprint 00 ✅ (archivado)
PoC con stream-json. Validó binary detection + JSONL parser + scaffold. Descartado como approach. Ver `docs/sprint-00-stream-json-exploration.md`.

### Sprint 01 — Claude en PTY (actual, 2–4 días)
- [ ] Limpiar código stream-json
- [ ] Agregar `portable-pty` + xterm.js + addons
- [ ] `shell_env.rs` con probe/load/merge de login shell
- [ ] `pty.rs` con comandos `pty_open`, `pty_write`, `pty_resize`, `pty_kill`
- [ ] `context/terminal.tsx` + `components/terminal-view.tsx`
- [ ] Wire: sidebar → `pty_open` con args apropiados
- [ ] Validar 9 pasos de `docs/sprint-01-claude-in-pty.md`

### Sprint 02 — Multi-tab + File tree básico (1 sem)
- [ ] Multi-PTY con tabs
- [ ] `fs.rs` + notify watcher
- [ ] File tree lazy con expand/collapse
- [ ] File viewer simple (leer archivo, syntax highlight)

### Sprint 03 — Git + Diff viewer (1-2 sem)
- [ ] `git.rs` (diff/status/log)
- [ ] Diff viewer con `@pierre/diffs`
- [ ] Badges A/M/D en file tree

### Sprint 04 — Terminal libre extra + SQLite settings (1 sem)
- [ ] Tabs de terminales adicionales (shell/zsh/arbitrario)
- [ ] `config.rs` con rusqlite
- [ ] Persistir proyectos favoritos, layout, theme

### Sprint 05 — Polish & Distribución (1-2 sem)
- [ ] Theming (dark/light)
- [ ] Keybindings configurables
- [ ] Auto-update con `tauri-plugin-updater`
- [ ] Packaging: dmg / nsis / deb

## Dependencias Clave

### Rust (`src-tauri/Cargo.toml`)

```toml
[dependencies]
tauri = { version = "2" }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
portable-pty = "0.8"         # PTY interactivo
which = "7"                  # detectar `claude`
dirs = "6"                   # ~/.claude/projects
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
anyhow = "1"
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
```

### TypeScript (`package.json`)

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-opener": "^2",
    "@xterm/xterm": "^5",
    "@xterm/addon-fit": "^0.10",
    "@xterm/addon-web-links": "^0.11",
    "solid-js": "^1.9",
    "tailwindcss": "^4"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4",
    "@tauri-apps/cli": "^2",
    "typescript": "~5.6",
    "vite": "^6",
    "vite-plugin-solid": "^2"
  }
}
```

## Comandos de Desarrollo

```bash
bun install
bun tauri dev        # dev
bun tauri build      # release
bun run typecheck    # tsc --noEmit
cd src-tauri && cargo check
```

## Notas de Diseño

1. **Claude Code es el motor; lo embebemos, no lo envolvemos.** Cero parsing del output. El TUI real rinde tal cual en xterm.js.

2. **Sin canal estructurado paralelo.** No hay stream-json, no hay tool_use JSON. Si algún día queremos hooks programáticos (ej. "cuando Claude edite, pre-commit"), lo hacemos observando **el filesystem y git**, no el PTY.

3. **La UI agrega contexto visual, no reemplaza funcionalidad.** Sidebar, file tree y diff viewer son **periféricos** al terminal. Si todos fallan, el terminal sigue siendo útil.

4. **Shell env hydration es no-negociable.** Sin `probe_shell_env`, herramientas como `Bash`/`git`/`rg` dentro de Claude fallan silenciosamente en macOS GUI apps.

5. **Archivos + git = source of truth.** No hay base de datos de conversaciones. `~/.claude/projects/` ya existe; lo leemos, no duplicamos.
