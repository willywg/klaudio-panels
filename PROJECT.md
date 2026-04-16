# Claude Desktop — Project Blueprint

> IDE desktop con Claude Code como motor de IA, edición de archivos y git diff.

## Objetivo

Construir una app de escritorio nativa queWrappea Claude Code CLI en una interfaz gráfica rica, con:

1. **Panel de Chat** — Claude Code corriendo en PTY integrado, con output parseado para diffs y file references
2. **Panel de Revisión** — Diff viewer (unificado y split-view) con syntax highlighting
3. **Editor de Archivos** — Visualizador/editor de archivos con tabs y syntax highlighting
4. **Árbol de Archivos** — File tree con diff-aware badges (A/D/M), file watching
5. **Terminal Integrada** — PTY completa para interacción directa con Claude Code u otros tools
6. **Git Diff** — Diff visual contra working tree, staged, y branches

## Stack Tecnológico

| Capa                 | Tecnología                                                 | Justificación                                                    |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| **Shell nativo**     | Tauri v2 (Rust)                                            | Binario pequeño, auto-update, plugins nativos, sidecar           |
| **Frontend UI**      | SolidJS 1.9                                                | Reactivo, ligero, mismo que OpenCode → conocimiento transferible |
| **CSS**              | TailwindCSS v4                                             | Utility-first, rápido de prototipar                              |
| **Componentes**      | Kobalte (headless) + custom                                | Accesibles, composables                                          |
| **Build**            | Vite 7                                                     | HMR rápido, ecosistema maduro                                    |
| **Terminal**         | xterm.js + node-pty (Electron) ó portable-pty (Rust/Tauri) | PTY real para Claude Code                                        |
| **Diff Engine**      | @pierre/diffs (inspiración) ó diff2html                    | Parsing y rendering de diffs                                     |
| **Syntax Highlight** | Shiki ó Monaco Editor                                      | Highlighting de código                                           |
| **Git**              | isomorphic-git ó libgit2 via Tauri command                 | Diff viewing, status                                             |
| **File Watching**    | @parcel/watcher (TS) ó notify (Rust)                       | Invalidación de cache en tiempo real                             |

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri v2 Window (Rust)                                      │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  SolidJS App (webview)                                 │ │
│  │                                                         │ │
│  │  ┌──────────────┐ ┌────────────────┐ ┌──────────────┐ │ │
│  │  │  Sidebar     │ │  Canvas         │ │  Right Panel  │ │ │
│  │  │              │ │                 │ │               │ │ │
│  │  │ ┌──────────┐│ │ ┌─────────────┐ │ │ ┌───────────┐ │ │ │
│  │  │ │ Sessions ││ │ │ Claude Code │ │ │ │ File Edit │ │ │ │
│  │  │ │ Projects ││ │ │ Chat        │ │ │ │ Diff View │ │ │ │
│  │  │ │          ││ │ │ (xterm.js)  │ │ │ │ Review    │ │ │ │
│  │  │ ├──────────┤│ │ │             │ │ │ │           │ │ │ │
│  │  │ │ File     ││ │ ├─────────────┤ │ │ │           │ │ │ │
│  │  │ │ Tree     ││ │ │ Terminal     │ │ │ │           │ │ │ │
│  │  │ │          ││ │ │ (xterm.js)  │ │ │ │           │ │ │ │
│  │  │ │          ││ │ └─────────────┘ │ │ └───────────┘ │ │ │
│  │  │ └──────────┘│ │                 │ │               │ │ │
│  │  └──────────────┘ └────────────────┘ └──────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Rust Backend (Tauri Commands)                               │
│  ├─ pty_manager: spawn/kill/read PTYs (Claude Code, shell)  │
│  ├─ fs_watcher: file system events                            │
│  ├─ git_ops: diff, status, log via git2                      │
│  ├─ file_ops: read/write/watch files                          │
│  └─ app_config: settings, projects, sessions                  │
└─────────────────────────────────────────────────────────────┘
```

## Layout de Paneles

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Desktop                                    ─ □ ✕       │
├──────────┬───────────────────────────────┬─────────────────────┤
│ Projects │  Claude Code (tab)            │  Review (tab)       │
│          │                               │                     │
│ ▸ src/   │  > Explícame este archivo     │  ▸ modified: 3      │
│   app.ts │                               │    src/app.tsx (+5) │
│ ▸ lib/   │  Claro, ese archivo maneja    │    lib/util.ts (-2) │
│   util   │  el routing de...             │    css/style.css    │
│ ▸ test/  │                               │                     │
│          │  > Y este diff?               │  ┌─────────────────┐│
│ Changes  │                               │  │ - const x = 1   ││
│  M app.ts│  El diff muestra que...       │  │ + const x = 2   ││
│  A lib.ts│                               │  │                 ││
│          │                               │  └─────────────────┘│
├──────────┼───────────────────────────────┼─────────────────────┤
│          │  Terminal ($ bash)            │                     │
│          │  $ git status                 │  File Editor        │
│          │  modified: src/app.tsx         │  (full height when  │
│          │  $ _                           │   no diff active)   │
└──────────┴───────────────────────────────┴─────────────────────┘
```

## Estructura del Proyecto

```
claude-desktop/
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs               # Entry point
│   │   ├── lib.rs                # Tauri setup, plugin registration
│   │   ├── pty.rs                # PTY management (spawn, read, write, resize)
│   │   ├── git.rs                # Git operations (diff, status, log) via git2
│   │   ├── fs.rs                 # File system operations + watcher (notify)
│   │   ├── config.rs             # App configuration persistence
│   │   └── claude.rs             # Claude Code CLI detection, spawn, handshake
│   └── capabilities/
│       └── default.json          # Tauri security permissions
│
├── src/                          # SolidJS frontend
│   ├── index.tsx                  # App entry, Platform adapter for Tauri
│   ├── entry.tsx                  # Router entry
│   ├── styles.css                 # Global styles (Tailwind)
│   │
│   ├── context/                  # SolidJS context providers
│   │   ├── pty.tsx               # PTY management (create, destroy, connect)
│   │   ├── project.tsx           # Active project, directory state
│   │   ├── file-tree.tsx         # File tree state (expand, collapse, filter)
│   │   ├── editor.tsx            # Open files, tabs, active file
│   │   ├── diff.tsx              # Diff state (source: git, branch, turn)
│   │   ├── git.tsx               # Git status, branches
│   │   ├── config.tsx            # App settings persistence
│   │   └── session.tsx           # Claude Code sessions
│   │
│   ├── components/               # UI Components
│   │   ├── layout/
│   │   │   ├── sidebar.tsx       # Left sidebar with sessions + file tree
│   │   │   ├── canvas.tsx        # Center panel (chat/terminal tabs)
│   │   │   └── review-panel.tsx  # Right panel (diff/editor)
│   │   │
│   │   ├── chat/
│   │   │   ├── claude-terminal.tsx   # xterm.js terminal running Claude Code
│   │   │   ├── chat-input.tsx        # Input for sending prompts to Claude
│   │   │   ├── chat-message.tsx      # Parsed message rendering
│   │   │   └── diff-detector.tsx     # Parse Claude output for diffs/file refs
│   │   │
│   │   ├── terminal/
│   │   │   ├── terminal-tabs.tsx      # Tabbed terminal instances
│   │   │   └── terminal-instance.tsx  # Single xterm.js terminal
│   │   │
│   │   ├── file-tree/
│   │   │   ├── tree.tsx              # Recursive file tree component
│   │   │   ├── tree-node.tsx         # Individual file/dir node
│   │   │   └── tree-badge.tsx        # Diff status badge (A/D/M)
│   │   │
│   │   ├── editor/
│   │   │   ├── file-tabs.tsx          # Open file tabs
│   │   │   ├── file-viewer.tsx        # Code viewer with syntax highlight
│   │   │   └── file-search.tsx        # Find within file
│   │   │
│   │   ├── diff/
│   │   │   ├── diff-viewer.tsx        # Unified and split diff
│   │   │   ├── diff-changes-bar.tsx   # Change magnitude indicator
│   │   │   └── diff-file-accordion.tsx # Per-file diff accordion
│   │   │
│   │   └── common/
│   │       ├── resizable-panels.tsx     # Drag-to-resize panel layout
│   │       ├── scroll-view.tsx          # Virtual scroll container
│   │       ├── tabs.tsx                 # Reusable tab component
│   │       └── button.tsx              # Button component
│   │
│   ├── lib/                       # Utilities (no UI)
│   │   ├── diff-parser.ts         # Parse unified diff format
│   │   ├── ansi-parser.ts         # Parse ANSI escape sequences from PTY
│   │   ├── shiki-loader.ts        # Lazy grammar loading for syntax highlight
│   │   └── path-utils.ts          # Path manipulation helpers
│   │
│   └── i18n/                     # Internationalization
│       ├── en.ts
│       └── es.ts
│
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── README.md
```

## Comunicación PTY ↔ UI

El core de la app. Claude Code se spawnea como PTY y su output se parsea para enriquecer la UI.

````
┌───────────────────────────────────────────────────────────────┐
│                    Data Flow                                   │
│                                                               │
│  User types prompt                                            │
│       │                                                       │
│       ▼                                                       │
│  chat-input.tsx ──write──► PTY (claude CLI stdin)             │
│                                                               │
│  PTY (claude CLI stdout) ──read──► ansi-parser.ts            │
│       │                                                       │
│       ├──► Terminal view (raw output, xterm.js canvas)        │
│       │                                                       │
│       ├──► diff-detector.tsx ──► diff-viewer.tsx              │
│       │    (detects "```diff" blocks,                          │
│       │     file paths like "Editing foo.ts")                 │
│       │                                                       │
│       └──► file-tree refresh (via fs watcher)                 │
│            (Claude modifies files → inotify event →           │
│             file tree updates with M/A badges)                │
└───────────────────────────────────────────────────────────────┘
````

## Claude Code Integration

### Detección y Spawn

```rust
// src-tauri/src/claude.rs
// 1. Detectar claude CLI en PATH
// 2. Validar versión
// 3. Spawnear como PTY con args apropiados
// 4. Exponer como Tauri command
```

El PTY de Claude Code se maneja a dos niveles:

1. **Nivel Rust (Tauri command)**: Spawnea el proceso, maneja lifecycle, redimensiona
2. **Nivel TS (xterm.js)**: Renderiza el output y permite input directo

### Modos de Interacción

| Modo                 | Input                                | Output                           |
| -------------------- | ------------------------------------ | -------------------------------- |
| **Terminal directo** | User escribe en xterm.js → PTY stdin | PTY stdout → xterm.js canvas     |
| **Chat enriquecido** | chat-input → PTY stdin (formatted)   | PTY stdout parseado → components |
| **Terminal libre**   | xterm.js (bash/zsh)                  | Shell normal                     |

### Parsing de Output de Claude Code

Claude Code genera output con:

- Bloques de diff: ` ```diff ... ``` `
- Indicadores de archivo: "Editing src/app.tsx", "Created lib/util.ts"
- Mensajes de texto en markdown
- ANSI codes para colores

El parser (`ansi-parser.ts` + `diff-detector.tsx`) desarrolla:

1. Stream de bytes del PTY → se decodifica (UTF-8 + ANSI strip)
2. Se detectan bloques diff → se envían al diff-viewer
3. Se detectan file paths → se actualiza el file tree con badges
4. El texto plano → se renderiza como markdown en el chat

## Git Diff — Flujo

```
┌──────────────────────────────────────────────┐
│  git command (Tauri IPC)                     │
│                                              │
│  git.tsx ──invoke──► git.rs (Tauri)         │
│     │                   │                     │
│     │                   ├─ git2::Repository   │
│     │                   │  .diff_index_to_   │
│     │                   │  workdir()         │
│     │                   │                    │
│     │                   ├─ staged diff       │
│     │                   └─ branch diff       │
│     │                                        │
│     └──► diff-viewer.tsx                     │
│          ├─ Unified mode                     │
│          └─ Split mode                       │
└──────────────────────────────────────────────┘
```

Fuentes de diff:

- **Working tree**: cambios sin commit (via `git2`)
- **Staged**: `git diff --cached`
- **Branch vs branch**: `git diff main..feature`
- **Claude turn**: diff generado por el último mensaje de Claude (detectado del output PTY)

## File Tree — Comportamiento

- Carga lazy: directorios se expanden bajo demanda
- Diff-aware: badges A (added), M (modified), D (deleted) obtenidos de `git status`
- File watching: via `notify` crate (Rust) → Tauri event → SolidJS signal
- Click en archivo → se abre en el editor panel (tab)
- Click en badge M → se abre el diff en el review panel

## Sessiones y Proyectos

```
~/.claude-desktop/
├── config.json              # App settings
├── projects/
│   ├── {project-hash}/
│   │   ├── meta.json        # Project name, path, last opened
│   │   └── sessions/
│   │       ├── {session-id}/
│   │       │   └── meta.json # Session metadata (claude args, cwd, created)
│   │       └── ...
│   └── ...
```

Cada "sesión" es una instancia de Claude Code PTY. El usuario puede tener múltiples sesiones por proyecto.

## Referencia de OpenCode — Qué estudiar y qué NO copiar

### Estudiar (inspiración de arquitectura y patrones)

| Path de OpenCode                                        | Qué aprender                                        |
| ------------------------------------------------------- | --------------------------------------------------- |
| `packages/desktop/src/index.tsx`                        | Patrón Platform adapter para Tauri                  |
| `packages/desktop/src-tauri/src/lib.rs`                 | Setup de Tauri, plugins, sidecar spawn              |
| `packages/desktop/src-tauri/src/cli.rs`                 | Sidecar spawn con stdio, WS config, health check    |
| `packages/desktop/src-tauri/src/server.rs`              | Patrón de servidor local para sidecar               |
| `packages/app/src/components/terminal.tsx`              | xterm.js integration, reconexión, resize            |
| `packages/app/src/context/terminal.tsx`                 | Gestión de sesiones de terminal, tabs, LRU cache    |
| `packages/app/src/context/file.tsx`                     | File loading con cache LRU, watcher, scroll restore |
| `packages/app/src/context/file/tree-store.ts`           | Estado de árbol lazy con expand/collapse            |
| `packages/app/src/components/file-tree.tsx`             | Componente de árbol con diff badges, drag & drop    |
| `packages/ui/src/components/session-review.tsx`         | Diff viewer con accordion, lazy render              |
| `packages/ui/src/components/session-diff.ts`            | Normalización de diffs a formato de vista           |
| `packages/ui/src/pierre/`                               | Engine de diff rendering, virtualización, selection |
| `packages/ui/src/components/file.tsx`                   | File viewer con syntax highlight, search, selection |
| `packages/app/src/pages/session/session-side-panel.tsx` | Layout de panels con tabs y drag                    |
| `packages/app/src/pages/session/terminal-panel.tsx`     | Panel de terminal con tabs y resize handle          |

### NO copiar (específico de OpenCode que no necesitas)

| Path de OpenCode                                      | Por qué no                                     |
| ----------------------------------------------------- | ---------------------------------------------- |
| `packages/opencode/`                                  | Toda la lógica del server LLM, providers, etc. |
| `packages/app/src/context/sdk.tsx`                    | SDK client para el server OpenCode             |
| `packages/app/src/context/sync.tsx`                   | Sync de mensajes via SSE con el server         |
| `packages/app/src/components/prompt-input/submit.ts`  | Submit al API de OpenCode                      |
| `packages/app/src/pages/session/message-timeline.tsx` | Timeline de mensajes del LLM propio            |
| `packages/sdk/`                                       | Client SDK autogenerado del API                |
| `packages/shared/`                                    | Utilidades específicas del protocolo OpenCode  |
| `packages/opencode/src/provider/`                     | Providers de Anthropic, OpenAI, Google, etc.   |
| `packages/opencode/src/session/`                      | Gestión de sesiones del server                 |

## Plan de Implementación — Fases

### Fase 1: Shell + Terminal (1-2 semanas)

**Objetivo**: App que abre una terminal con Claude Code corriendo dentro.

- [ ] Setup proyecto Tauri v2 + SolidJS + TailwindCSS + Vite
- [ ] Implementar `pty.rs` (Tauri command) que spawnea Claude Code como PTY
- [ ] Implementar `terminal-instance.tsx` (xterm.js connected al PTY via Tauri IPC)
- [ ] Layout básico: sidebar vacía + panel central con terminal
- [ ] Probar que Claude Code corre y responde en la terminal

**Referencia clave**: `packages/desktop/src-tauri/src/cli.rs` (sidecar spawn), `packages/app/src/components/terminal.tsx` (xterm.js)

### Fase 2: File Tree + File Viewer (1-2 semanas)

**Objetivo**: Navegar archivos del proyecto y ver su contenido.

- [ ] Implementar `fs.rs` (Tauri commands: readdir, readfile, watch)
- [ ] Implementar `file-tree.tsx` (árbollazy con expand/collapse)
- [ ] Implementar `file-viewer.tsx` (syntax highlighting con Shiki)
- [ ] Implementar `file-tabs.tsx` (tabs de archivos abiertos)
- [ ] Panel derecho con file viewer al hacer click en archivo del árbol

**Referencia clave**: `packages/app/src/components/file-tree.tsx`, `packages/ui/src/components/file.tsx`, `packages/app/src/context/file.tsx`

### Fase 3: Git Diff + Review Panel (1-2 semanas)

**Objetivo**: Ver diffs visuales de cambios hechos por Claude.

- [ ] Implementar `git.rs` (Tauri commands: diff, status, log via git2)
- [ ] Implementar `diff-viewer.tsx` (unificado y split-view)
- [ ] Implementar `diff-changes-bar.tsx` (indicador de magnitud de cambios)
- [ ] Integrar diff badges en file tree (A/D/M)
- [ ] Fuentes de diff: working tree, staged, branch

**Referencia clave**: `packages/ui/src/components/session-review.tsx`, `packages/ui/src/pierre/`, `packages/ui/src/components/session-diff.ts`

### Fase 4: Chat Enhancement (1-2 semanas)

**Objetivo**: Parsear output de Claude para enriquecer la UI.

- [ ] Implementar `diff-detector.tsx` (detectar bloques diff en output de Claude)
- [ ] Implementar `chat-message.tsx` (renderizar markdown del output)
- [ ] Auto-link: archivo mencionado por Claude → click abre en editor
- [ ] Auto-link: diff mencionado por Claude → click abre en review panel
- [ ] chat-input.tsx: input rico con envío a PTY de Claude

### Fase 5: Sessions + Projects (1 semana)

**Objetivo**: Multi-proyecto y multi-sesión.

- [ ] Implementar `config.rs` (persistencia de proyectos y sesiones)
- [ ] Sidebar con lista de proyectos
- [ ] Sesiones por proyecto (múltiples instancias de Claude Code)
- [ ] Switch entre proyectos sin cerrar terminales
- [ ] Configuración de Claude Code args per-proyecto (model, system prompt, etc.)

### Fase 6: Polish (1-2 semanas)

- [ ] Theming (dark/light, integración con tema del SO)
- [ ] Atajos de teclado configurables
- [ ] i18n mínimo (EN, ES)
- [ ] Auto-update via tauri-plugin-updater
- [ ] Packaging: dmg (mac), nsis (win), deb/rpm (linux)
- [ ] Icono, nombre, branding

## Dependencias Clave

### Rust (Cargo.toml)

```toml
[dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
tauri-plugin-opener = "2"
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-store = "2"
tauri-plugin-updater = "2"
tauri-plugin-notification = "2"
tauri-plugin-clipboard-manager = "2"
tauri-plugin-process = "2"
portable-pty = "0.8"       # PTY platform-native
git2 = "0.20"              # libgit2 bindings
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
notify = "7"               # File watching
uuid = { version = "1", features = ["v4"] }
```

### TypeScript (package.json)

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-shell": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-fs": "^2",
    "@tauri-apps/plugin-store": "^2",
    "@tauri-apps/plugin-clipboard-manager": "^2",
    "@tauri-apps/plugin-notification": "^2",
    "@tauri-apps/plugin-updater": "^2",
    "@tauri-apps/plugin-process": "^2",
    "solid-js": "^1.9",
    "@solidjs/router": "^0.15",
    "@kobalte/core": "^0.13",
    "@xterm/xterm": "^5",
    "@xterm/addon-fit": "^0.10",
    "@xterm/addon-web-links": "^0.11",
    "@xterm/addon-serialize": "^0.13",
    "shiki": "^3",
    "diff": "^7",
    "isomorphic-git": "^1",
    "@solid-primitives/i18n": "^2",
    "@solid-primitives/storage": "^0.1",
    "tailwindcss": "^4"
  },
  "devDependencies": {
    "vite": "^7",
    "vite-plugin-solid": "^2",
    "@tauri-apps/cli": "^2",
    "typescript": "^5"
  }
}
```

## Comandos de Desarrollo

```bash
# Crear proyecto desde cero
pnpm create tauri-app claude-desktop --template solid-ts

# Desarrollo
pnpm tauri dev

# Build producción
pnpm tauri build

# Type checking (SolidJS)
pnpm typecheck

# Linting
pnpm lint
```

## Notas de Diseño

1. **Claude Code es el motor** — No reemplazamos Claude Code, lo wrappeamos. La terminal es primera clase, no un add-on.

2. **Parse, don't reinvent** — Claude Code ya hace el trabajo pesado (editar archivos, correr comandos, razonar). Nuestra app:
   - Muestra su output bonito (syntax highlight, diff viewer)
   - Da contexto visual (file tree, git diff)
   - Permite interacción directa cuando se necesita (terminal libre)

3. **Archivos son fuente de verdad** — El file system es el estado. Git es el historial. No necesitamos un server propio ni una base de datos compleja. El `.git` del proyecto es nuestro "backend".

4. **Mínimo código, máxima reutilización** — Cada componente debe poder funcionar independientemente. La terminal sin el file tree funciona. El file tree sin el diff viewer funciona. Esto permite desarrollo iterativo.
