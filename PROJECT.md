# Claude Desktop — Project Blueprint

> IDE de escritorio con Claude Code como motor de IA, edición de archivos, git diff y terminal libre.

## Objetivo

App de escritorio nativa construida con Tauri v2 + SolidJS que wrappea el CLI de Claude Code con un enfoque **híbrido** (stream-json JSON + PTY opcional) para ofrecer:

1. **Panel de Chat** — Cliente estructurado sobre `claude -p --output-format stream-json` (NO TUI parsing). Renderiza tool calls, mensajes y edits como eventos JSON tipados.
2. **Panel de Revisión** — Diff viewer (unificado y split-view) con syntax highlighting, integrado con `@pierre/diffs`.
3. **Editor de Archivos** — Visualizador/editor con tabs y syntax highlighting (Shiki).
4. **Árbol de Archivos** — File tree con diff-aware badges (A/D/M), file watching en vivo.
5. **Terminal Libre** — PTY completa (portable-pty + xterm.js) para shell/claude interactivo u otros tools.
6. **Git Diff** — Diff visual contra working tree, staged, branches y "turno de Claude".

## Estrategia de Integración con Claude Code — Híbrida

Dos canales independientes para interactuar con Claude Code:

### Canal primario: stream-json (programático, estructurado)

```bash
claude -p "<prompt>" \
  --model <model> \
  --output-format stream-json \
  --verbose \
  [--resume <session-id>] [-c]
```

- Se spawnea como **subproceso normal con pipes** (no PTY) desde Rust (`tokio::process::Command` + `Stdio::piped()`).
- stdout emite JSON por línea: eventos `system/init` (con `session_id`), `assistant`, `user`, `tool_use`, `tool_result`, etc.
- El frontend recibe cada evento via Tauri IPC y construye la UI del chat sin parsear ANSI ni TUI.
- Validado como patrón en **Claudia** (getAsterisk/claudia), que hace exactamente esto.

### Canal secundario: PTY libre (interactivo)

- Terminal completa (`portable-pty` en Rust + `xterm.js` en frontend) para uso libre.
- Permite correr `claude` en modo TUI nativo si el usuario lo prefiere, o `bash/zsh`, `git`, `pnpm`, etc.
- Independiente del chat estructurado — cada uno puede funcionar sin el otro.

### Persistencia de sesiones

**No inventamos almacenamiento propio.** Claude Code ya persiste cada sesión en:

```
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

La app lee estos JSONL para listar historia, reanudar sesiones (`--resume <id>`), y mostrar conversaciones previas. Para **configuración de la app** (ventanas, atajos, proyectos favoritos, preferencias) usamos **SQLite** (`rusqlite`, bundled).

## Stack Tecnológico

| Capa                 | Tecnología                                      | Justificación                                           |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| **Shell nativo**     | Tauri v2 (Rust)                                 | Binario pequeño, auto-update, plugins nativos          |
| **Frontend UI**      | SolidJS 1.9                                     | Reactivo, ligero, ergonómico con signals               |
| **CSS**              | TailwindCSS v4                                  | Utility-first, rápido                                   |
| **Componentes**      | Kobalte (headless) + custom                     | Accesibles, composables                                 |
| **Build**            | Vite 7                                          | HMR rápido                                              |
| **Terminal libre**   | xterm.js + portable-pty (Rust)                  | PTY nativa para shell arbitrario                        |
| **Chat estructurado**| `claude -p --output-format stream-json` + pipes | Sin ANSI parsing, eventos tipados                       |
| **Diff Engine**      | `@pierre/diffs` (npm `1.1.0-beta.18`)           | Motor de rendering probado en OpenCode                  |
| **Syntax Highlight** | Shiki                                           | Lazy grammar loading, temas                             |
| **Git**              | `git2` (libgit2) via Tauri commands             | Diff, status, log nativo                                |
| **File Watching**    | `notify` (Rust) → Tauri event                   | Refresco de file tree en vivo                           |
| **App state**        | `rusqlite` (bundled)                            | Settings, proyectos favoritos, preferencias            |
| **Sesiones**         | `~/.claude/projects/**/*.jsonl` (Claude Code)   | Reutilizamos storage nativo, no duplicamos              |

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri v2 Window (Rust)                                      │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  SolidJS App (webview)                                 │ │
│  │  ┌──────────────┐ ┌────────────────┐ ┌──────────────┐ │ │
│  │  │  Sidebar     │ │  Canvas         │ │  Right Panel  │ │ │
│  │  │ Projects     │ │ Chat (JSON)     │ │ Diff / Editor │ │ │
│  │  │ Sessions     │ │ Terminal (PTY)  │ │               │ │ │
│  │  │ File Tree    │ │                 │ │               │ │ │
│  │  └──────────────┘ └────────────────┘ └──────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Rust Backend (Tauri Commands + Events)                     │
│  ├─ claude.rs    : spawn `claude -p ... stream-json`, pipes │
│  │                  parse JSON lines → emit per-session      │
│  ├─ pty.rs       : portable-pty (shell/terminal libre)       │
│  ├─ fs.rs        : readdir/read/write + notify watcher       │
│  ├─ git.rs       : diff/status/log via git2                  │
│  ├─ sessions.rs  : parse ~/.claude/projects/**/*.jsonl       │
│  ├─ binary.rs    : detectar/validar binary `claude` (which)  │
│  └─ config.rs    : SQLite para settings                      │
└─────────────────────────────────────────────────────────────┘
```

## Layout de Paneles

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Desktop                                    ─ □ ✕       │
├──────────┬───────────────────────────────┬─────────────────────┤
│ Projects │  Chat (tab)                   │  Review (tab)       │
│          │                               │                     │
│ ▸ src/   │  [user]  Explícame app.ts     │  ▸ modified: 3      │
│   app.ts │                               │    src/app.tsx (+5) │
│ ▸ lib/   │  [assistant] El archivo       │    lib/util.ts (-2) │
│   util   │  maneja el routing...         │                     │
│ ▸ test/  │                               │  ┌─────────────────┐│
│          │  [tool_use] Edit src/app.tsx  │  │ - const x = 1   ││
│ Changes  │  ├─ show diff                 │  │ + const x = 2   ││
│  M app.ts│                               │  │                 ││
│  A lib.ts│  [input] > ... ⏎ send         │  └─────────────────┘│
├──────────┼───────────────────────────────┼─────────────────────┤
│ Sessions │  Terminal (tab)               │                     │
│ ▸ jul 12 │  $ git status                 │  File Editor        │
│ ▸ jul 11 │  $ _                          │                     │
└──────────┴───────────────────────────────┴─────────────────────┘
```

## Estructura del Proyecto

```
claude-desktop/
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs               # Entry
│   │   ├── lib.rs                # Tauri setup, plugin registration
│   │   ├── claude.rs             # stream-json spawn + JSON-line emitter
│   │   ├── pty.rs                # portable-pty (terminal libre)
│   │   ├── binary.rs             # `which claude` + fallbacks, versión
│   │   ├── sessions.rs           # Parseo de ~/.claude/projects/**/*.jsonl
│   │   ├── git.rs                # Git ops (diff/status/log) via git2
│   │   ├── fs.rs                 # Readdir/read/write/watch (notify)
│   │   └── config.rs             # SQLite para settings de app
│   └── capabilities/
│       └── default.json
│
├── src/                          # SolidJS frontend
│   ├── index.tsx                  # App entry
│   ├── entry.tsx                  # Router
│   ├── styles.css                 # Tailwind
│   │
│   ├── context/
│   │   ├── claude.tsx            # Estado de chat: mensajes, tool calls, session
│   │   ├── pty.tsx               # PTY lifecycle (crear/destruir/reconectar)
│   │   ├── project.tsx           # Proyecto activo
│   │   ├── file-tree.tsx         # Árbol lazy
│   │   ├── editor.tsx            # Tabs, archivo activo
│   │   ├── diff.tsx              # Diff source (git/staged/branch/turn)
│   │   ├── git.tsx               # Git status, branches
│   │   ├── config.tsx            # Settings persistidos
│   │   └── session.tsx           # Listado/switch de sesiones
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── sidebar.tsx
│   │   │   ├── canvas.tsx
│   │   │   └── review-panel.tsx
│   │   │
│   │   ├── chat/
│   │   │   ├── chat-view.tsx          # Timeline de eventos JSON
│   │   │   ├── chat-input.tsx         # Input → invoke claude command
│   │   │   ├── message-user.tsx       # Mensaje del usuario
│   │   │   ├── message-assistant.tsx  # Mensaje del assistant (markdown)
│   │   │   ├── tool-call.tsx          # Render de tool_use (Edit/Bash/Read)
│   │   │   └── tool-result.tsx        # Resultado de tool
│   │   │
│   │   ├── terminal/
│   │   │   ├── terminal-tabs.tsx
│   │   │   └── terminal-instance.tsx  # xterm.js ↔ pty via Tauri IPC
│   │   │
│   │   ├── file-tree/
│   │   │   ├── tree.tsx
│   │   │   ├── tree-node.tsx
│   │   │   └── tree-badge.tsx         # A/D/M
│   │   │
│   │   ├── editor/
│   │   │   ├── file-tabs.tsx
│   │   │   ├── file-viewer.tsx
│   │   │   └── file-search.tsx
│   │   │
│   │   ├── diff/
│   │   │   ├── diff-viewer.tsx        # wrapper de @pierre/diffs
│   │   │   ├── diff-changes-bar.tsx
│   │   │   └── diff-file-accordion.tsx
│   │   │
│   │   └── common/
│   │       ├── resizable-panels.tsx
│   │       ├── tabs.tsx
│   │       └── button.tsx
│   │
│   ├── lib/
│   │   ├── claude-events.ts       # Tipos de eventos stream-json
│   │   ├── jsonl-parser.ts        # Parseo de sesiones .jsonl
│   │   ├── diff-source.ts         # Normaliza git diff → formato pierre
│   │   └── path-utils.ts
│   │
│   └── i18n/
│       ├── en.ts
│       └── es.ts
│
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── README.md
```

## Data Flow — Chat con stream-json

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  chat-input.tsx                                              │
│     │ user submits prompt                                    │
│     ▼                                                        │
│  invoke('claude_send', { prompt, model, sessionId? })        │
│     │                                                        │
│     ▼                                                        │
│  claude.rs (Rust)                                            │
│     ├─ find_claude_binary() (which + fallbacks)              │
│     ├─ tokio::Command::new(claude).args([...])               │
│     │    -p, --output-format stream-json, --verbose,         │
│     │    --model, [--resume SESSION], [-c]                   │
│     ├─ Stdio::piped() (stdin/stdout/stderr, NO PTY)          │
│     ├─ loop: read stdout line → parse JSON → emit event      │
│     │    "claude:event:<session-id>" { type, ... }           │
│     └─ on 'system/init' → capture session_id, register       │
│                                                              │
│  claude.tsx (SolidJS context)                                │
│     │ listen('claude:event:<session-id>', ...)               │
│     ▼                                                        │
│  store update: messages[], toolCalls[], status               │
│     │                                                        │
│     ▼                                                        │
│  chat-view.tsx renders tipos:                                │
│     - 'assistant' → markdown                                 │
│     - 'tool_use' (Edit/Write) → tool-call + open diff        │
│     - 'tool_result' → tool-result                            │
│                                                              │
│  Side effects en el filesystem:                              │
│     - Claude modifica archivos                               │
│     - notify watcher → actualiza file tree con badges M/A    │
│     - git.rs recalcula diff → review panel                   │
└──────────────────────────────────────────────────────────────┘
```

### Eventos stream-json relevantes

| `type` / `subtype`          | Uso en UI                                          |
| --------------------------- | -------------------------------------------------- |
| `system` / `init`           | Capturar `session_id`, metadata de inicio          |
| `assistant`                 | Bloque de mensaje del assistant (markdown, stream) |
| `user`                      | Echo del prompt del usuario                        |
| `tool_use` (Edit/Write)     | Trigger del diff viewer con before/after          |
| `tool_use` (Bash/Read/Glob) | Render compacto con input/status                   |
| `tool_result`               | Output del tool (expandible)                      |
| `result`                    | Sesión terminó, mostrar cost/tokens                |

## Git Diff — Flujo

```
git.tsx ──invoke──► git.rs
                      ├─ git2::Repository::diff_index_to_workdir()
                      ├─ staged: diff_tree_to_index()
                      ├─ branch: diff_tree_to_tree(a, b)
                      └─ turn:  snapshot antes/después del run
                                (tomado en 'system/init' vs 'result')
```

Fuentes de diff para el review panel:

- **Working tree**: cambios sin commit
- **Staged**: `git diff --cached`
- **Branch vs branch**: `git diff main..feature`
- **Claude turn**: diff entre snapshots tomados al inicio y fin del run

## File Tree

- Carga lazy por directorio
- Badges A/M/D desde `git status`
- File watching con `notify` → Tauri event → signal SolidJS
- Click archivo → abre en editor
- Click badge M → abre diff en review panel

## Detección del Binary de Claude Code

```rust
// src-tauri/src/binary.rs
// 1. Config override (guardado en SQLite)
// 2. `which claude` via `which` crate
// 3. Fallbacks comunes:
//    - ~/.local/bin/claude
//    - /usr/local/bin/claude
//    - Node global bins (nvm, volta, fnm, asdf)
// 4. Validar: `claude --version` returns OK
// 5. Si no existe: mostrar diálogo con link a npm i -g @anthropic-ai/claude-code
```

Patrón directamente reusable de Claudia (`src-tauri/src/claude_binary.rs`).

## Referencias del Ecosistema

### Claudia (getAsterisk/claudia) — referencia principal

**Por qué**: es exactamente el caso de uso (Tauri GUI wrappeando Claude Code CLI via stream-json). Stack React, no SolidJS, pero los patrones de integración transfieren 1:1.

| Path de Claudia                                  | Qué aprender                                           |
| ------------------------------------------------ | ------------------------------------------------------ |
| `src-tauri/src/claude_binary.rs`                 | Detección/validación del binary `claude`               |
| `src-tauri/src/commands/claude.rs`               | Spawn de `claude -p` con stream-json, event emission   |
| `src-tauri/src/commands/claude.rs::list_projects`| Parseo de `~/.claude/projects/**`                      |
| `src-tauri/src/process/registry.rs`              | Registro de sesiones activas                           |
| `src/components/ClaudeCodeSession.tsx`           | UI del chat con eventos JSON (React)                   |
| `src/components/FloatingPromptInput.tsx`         | Input de prompt con model picker, file refs            |
| `src/services/sessionPersistence.ts`             | Persistencia de state de UI                            |

### OpenCode (anomalyco/opencode) — inspiración de UI/diff

**Atención**: OpenCode **no** spawnea Claude Code. Tiene su propio server LLM y su CLI es el agente. Lo útil son patrones de UI.

| Path de OpenCode                                | Qué aprender                                         | Qué NO tomar                              |
| ----------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `packages/ui/src/components/session-review.tsx` | Diff viewer con accordion, lazy render               | —                                         |
| `packages/ui/src/components/session-diff.ts`    | Normalización de diffs para `@pierre/diffs`          | —                                         |
| `packages/ui/src/pierre/`                       | Integración con motor `@pierre/diffs`                | —                                         |
| `packages/ui/src/components/file.tsx`           | File viewer con syntax highlight + selection         | —                                         |
| `packages/app/src/components/file-tree.tsx`     | Árbol con diff badges, drag & drop                   | —                                         |
| `packages/app/src/context/file.tsx`             | File cache LRU, watcher, scroll restore              | —                                         |
| `packages/app/src/context/file/tree-store.ts`   | Store de árbol lazy                                  | —                                         |
| `packages/desktop/src-tauri/src/cli.rs`         | **NO es spawn de PTY** — es sidecar HTTP via pipes   | No usarlo como base para `claude.rs`      |
| `packages/app/src/components/terminal.tsx`      | Usa `ghostty-web` + WebSocket (no xterm.js, no PTY local) | No aplica — nuestra terminal es local |
| `packages/opencode/`                            | —                                                    | Todo el server LLM propio, providers, etc. |
| `packages/sdk/`                                 | —                                                    | SDK autogenerado para su API              |

## Plan de Implementación — Fases

### Fase 1: Scaffolding + Chat mínimo con stream-json (1 sem)

**Objetivo**: enviar un prompt y ver la respuesta de Claude renderizada.

- [ ] `bun create tauri-app claude-desktop` con template SolidJS + TS
- [ ] Configurar TailwindCSS v4 + Vite 7
- [ ] `binary.rs`: detectar `claude` en PATH + diálogo si falta
- [ ] `claude.rs`: comando Tauri `claude_send(prompt, model)` que spawnea `claude -p ... stream-json` y emite eventos
- [ ] `context/claude.tsx`: listener + store de mensajes
- [ ] `chat-view.tsx` + `chat-input.tsx` mínimos (sin tool calls aún)
- [ ] Verificar: escribir prompt → recibir respuesta del assistant

**Referencia**: Claudia `src-tauri/src/commands/claude.rs::execute_claude_code` + `spawn_claude_process`.

### Fase 2: Tool calls + File tree + File viewer (1-2 sem)

- [ ] Render de `tool_use` (Edit/Write/Bash/Read) en chat
- [ ] `fs.rs`: readdir, readfile, notify watcher
- [ ] `file-tree.tsx` lazy con expand/collapse
- [ ] `file-viewer.tsx` con Shiki
- [ ] `file-tabs.tsx`

**Referencia**: OpenCode `file-tree.tsx`, `file.tsx`, `context/file.tsx`.

### Fase 3: Git Diff + Review Panel (1-2 sem)

- [ ] `git.rs`: diff working tree, staged, branch
- [ ] Integrar `@pierre/diffs` en `diff-viewer.tsx`
- [ ] Badges A/D/M en file tree
- [ ] "Claude turn diff": snapshot antes/después del run

**Referencia**: OpenCode `session-review.tsx`, `session-diff.ts`, `pierre/`.

### Fase 4: Terminal libre con PTY (1 sem)

- [ ] `pty.rs`: portable-pty spawn/read/write/resize
- [ ] `terminal-instance.tsx`: xterm.js ↔ Tauri IPC
- [ ] Tabs de terminal
- [ ] Independiente del chat

### Fase 5: Sesiones + Proyectos (1 sem)

- [ ] `sessions.rs`: parsear `~/.claude/projects/**/*.jsonl`
- [ ] Lista de sesiones por proyecto en sidebar
- [ ] Reanudar sesión: `claude -p --resume <id>`
- [ ] Continuar última: `claude -p -c`
- [ ] Multi-proyecto (switch sin perder estado)

**Referencia**: Claudia `list_projects`, `list_sessions`.

### Fase 6: Polish + Distribución (1-2 sem)

- [ ] Theming (dark/light, auto-match SO)
- [ ] Keybindings configurables
- [ ] i18n (EN, ES)
- [ ] Auto-update (`tauri-plugin-updater`)
- [ ] Packaging: dmg (mac), nsis (win), deb/rpm (linux)
- [ ] Branding, icono

## Dependencias Clave

### Rust (`src-tauri/Cargo.toml`)

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
tauri-plugin-window-state = "2"

# Claude Code integration
which = "7"                 # Detectar binary de claude
tokio = { version = "1", features = ["full"] }
futures = "0.3"

# PTY (terminal libre)
portable-pty = "0.8"

# Git
git2 = "0.20"

# File watching
notify = "7"

# App state
rusqlite = { version = "0.32", features = ["bundled"] }

# Utils
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
dirs = "6"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

### TypeScript (`package.json`)

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
    "@tauri-apps/plugin-window-state": "^2",
    "solid-js": "^1.9",
    "@solidjs/router": "^0.15",
    "@kobalte/core": "^0.13",
    "@xterm/xterm": "^5",
    "@xterm/addon-fit": "^0.10",
    "@xterm/addon-web-links": "^0.11",
    "@xterm/addon-serialize": "^0.13",
    "shiki": "^3",
    "@pierre/diffs": "^1.1.0-beta.18",
    "diff": "^8",
    "marked": "^17",
    "@solid-primitives/i18n": "^2",
    "@solid-primitives/storage": "^4",
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

## Notas de Diseño

1. **Claude Code es el motor; no lo reimplementamos.** Dos canales: stream-json para el chat rico (estructurado, estable) + PTY libre para interacción directa.

2. **No parsear TUI.** `stream-json` nos da eventos tipados; ANSI/TUI parsing sería frágil y se rompería en updates del CLI.

3. **Archivos son la fuente de verdad.** El filesystem + git es nuestro "backend". `~/.claude/projects/` es nuestra "base de datos" de sesiones. SQLite solo para settings de la app.

4. **Componentes autónomos.** Terminal sin file tree funciona. File tree sin diff viewer funciona. Chat sin terminal funciona. Iterar por partes es viable.

5. **Referencias: Claudia para integración con Claude, OpenCode para UI/diff.** Cada una aporta en su dominio; no mezclar.

## Comandos de Desarrollo

```bash
# Crear proyecto
bun create tauri-app claude-desktop --template solid-ts

# Desarrollo
bun tauri dev

# Build
bun tauri build

# Type check
bun run typecheck

# Lint
bun run lint
```
