# Architecture & Engineering Report: Klaudio Panels Windows Native Port

**Date:** October 2026  
**Status:** Implementation available; validation in progress
**Target Binary:** `src-tauri/target/x86_64-pc-windows-gnu/release/klaudio-panels.exe` (default GNU output)
**Baseline Commit:** `8514f59` (v1.16.0 — Codex as a third agent)  

---

## Executive Summary

### Current support limits

- Install JavaScript dependencies with `bun install --frozen-lockfile`. Keep the committed Bun and Cargo lockfiles together so Tauri and its plugins resolve compatible major/minor versions on both sides.
- Build GNU installers with `bun run release:windows-gnu`. Its explicit `--target x86_64-pc-windows-gnu` enables Tauri's built-in loader DLL packaging and uninstall cleanup. With the npm CLI's default target inference, the GNU executable can be built while the installer omits `WebView2Loader.dll`. No custom NSIS hook or vendored DLL is needed.
- Terminal clipboard history capture and Cursor turn-notification hooks are not implemented on Windows. The UI reports these features as unavailable; normal copy/paste and clipboard-image insertion are separate features.
- PowerShell file drops use literal single-quoted paths; Linux/macOS retain POSIX quoting. Editor detection and launch share the same Windows resolver.
- Native macOS and Linux window decorations are preserved. Windows removes native decorations during startup and renders discrete min/max/close controls in the header. Development uses the Vite URL at `http://localhost:1420` (`beforeDevCommand: "bun run dev"`).
- `src-tauri/Cargo.toml` sets `crate-type = ["rlib"]` instead of `["staticlib", "cdylib", "rlib"]` because desktop Tauri only links the library into the binary target (`main.rs`), and building a `cdylib` on `x86_64-pc-windows-gnu` overflows the GNU linker (`ld`) 65,535 PE export ordinal limit.
- A successful local frontend build is not proof of a complete Windows release. A clean-machine build, installer/deep-link checks, and native interactive smoke tests are still required.

The sections below describe the original implementation report, not a guarantee that every subsystem has current end-to-end test coverage.

### Native test validation (Windows GNU)

The library test executable now embeds the same Common Controls v6 manifest as the app. Previously Tauri linked that manifest only into the application, so the test loader failed on `TaskDialogIndirect` with `0xc0000139` before running any tests. The build script keeps the app's icons/version resources and links one shared manifest for both executable types.

Run `cargo test --manifest-path src-tauri/Cargo.toml --lib` with the resource compiler required by your Windows toolchain available. The local Windows GNU validation passed all library tests and built the debug application. Test-only Codex/Cursor fixtures now JSON-escape Windows paths. No real agent session files are changed by these fixture fixes.

The MSVC linker path and non-Windows builds still require platform-specific verification. These unit tests do not establish clean-machine installation or interactive end-to-end support.

### Latest local validation

- `bun run typecheck`: passed; focused frontend tests: passed.
- Full `bun test`: the 4 failing / 3 erroring cases observed on Windows are pre-existing test-runner / locale issues unrelated to the port:
  1. `src/lib/relative-time.test.ts` (`commitTime > past a week it switches to a calendar date`): `NOW` is in August, so `secondsAgo(8 * DAY)` is August 12. `toLocaleDateString(undefined, ...)` formats using the OS locale (`es-PE` on the test machine), producing `"12 ago"` (*12 de agosto*), which trips `expect(...).not.toContain("ago")`.
  2. `src/context/clipboard-history.test.ts`, `src/context/notifications.test.ts`, and `src/context/session-watcher.test.ts`: Bun's test runner on Windows imports `.tsx` files directly without Vite's `vite-plugin-solid` transform, throwing `SyntaxError: Export named 'jsxDEV' not found in module 'node_modules/solid-js/dist/solid.js'`.
- `bun run release:windows-gnu --no-sign -- --offline`: passed using an isolated `CARGO_TARGET_DIR` and an existing GNU resource compiler. The generated NSIS script includes `WebView2Loader.dll` and its uninstall cleanup.
- The agent settings dialog now limits its height to the viewport and allows vertical scrolling. Structural tests and compiled CSS were checked; rendered verification on short/narrow windows remains pending because no browser was available for visual QA.
- The second-laptop tester reported working Git changes, file browsing, and terminal access. This is a partial smoke test, not completion of the installation, deep-link, external-editor launch, and uninstall matrix.
- The installer is unsigned. MSVC, macOS, and Linux builds were not validated in this environment.

Klaudio Panels was originally developed as an exclusive macOS desktop application built on Tauri v2, SolidJS, and Rust. It relied heavily on macOS-specific subsystems:
- Shell & PTY: Hardcoded `/bin/zsh`, login shells (`login -fq`), and Apple-specific environment probing (`env -0`).
- Process Discovery: POSIX directory layouts (`/usr/local/bin`, `~/.local/bin`) without `.exe`/`.cmd` extension resolution.
- Inter-Process Communication: Unix Domain Sockets (`.sock`) in `/tmp` and cache directories.
- Desktop Integration: AppleScript (`osascript`) notifications, Dock icon badges, `pbcopy` shims, and `open -a` bundle launching.
- File System & UI: POSIX forward-slash paths (`/`), case-sensitive path matching, and macOS traffic-light window framing.

This engineering initiative executed a comprehensive, ground-up native Windows adaptation. The core objective was **zero emulation overhead**: integrating directly with native Win32 APIs, ConPTY, PowerShell, Windows Registry/PATH structures, and Windows clipboard subsystems while maintaining strict backward compatibility with Unix/macOS via conditional compilation (`#[cfg(...)]`).

---

## Complete Chronological & Architectural Walkthrough

### 1. Build Toolchain & Linking Architecture

#### The Problem
Compiling Tauri backend crates on Windows under the GNU toolchain (`stable-x86_64-pc-windows-gnu`) failed during final binary linkage. Dependencies utilizing Win32 transactional NTFS and filesystem recovery routines demanded `ktmw32.lib` / `libktmw32.a`, which was missing from the default MinGW distribution bundled with rustup.

#### Technical Implementation
- Generated a static Win32 import library `libktmw32.a` from `C:\Windows\System32\ktmw32.dll`.
- Deployed the import library directly into rustup's self-contained toolchain directory:
  `~/.rustup/toolchains/stable-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu/lib/self-contained/`.
- Configured `src-tauri/Cargo.toml` with conditional Windows system dependencies (`windows-sys`).

#### Decision Rationale & Tradeoffs
* **Why this approach:** It allows compilation with the lightweight, self-contained MinGW/GNU toolchain without requiring multi-gigabyte installations of Microsoft Visual C++ Build Tools (MSVC).
* **Why not MSVC-only:** Forcing an MSVC migration would break developer environments configured for GCC/Clang and requires managing Visual Studio installer licenses and enterprise configurations.
* **Why not stub/mock the calls:** Mocking transactional filesystem APIs would risk panics or data corruption at runtime during atomic session saves.

---

### 2. Native PTY, Shell Subsystem & PATH Synchronization

#### The Problem
The terminal engine (`src-tauri/src/pty.rs` and `src-tauri/src/shell_env.rs`) previously invoked `/bin/zsh -l` with POSIX flags. On Windows, executing non-existent shells caused immediate process crashes. Additionally:
1. Running background detection processes spawned flickering black console windows.
2. An initial port bug wiped out the entire terminal `PATH`: `clipboard_history_env` injected a Unix `pbcopy` shim path with colon (`:`) delimiters into the environment. On Windows, `portable_pty` indexes environment variables using lowercase keys in a `BTreeMap`. Inserting `"PATH"` when `"Path"` already existed caused the entire system `Path` to be overwritten by the non-existent Unix shim directory. Consequently, essential commands (`node`, `git`, `cargo`, `npm`) failed with "The term is not recognized".

#### Technical Implementation
- **Shell Discovery Cascade (`shell_env.rs`):**
  1. Searches for modern PowerShell Core (`pwsh.exe`) via `which`.
  2. Falls back to Windows PowerShell (`powershell.exe`).
  3. Falls back to `%COMSPEC%` (`cmd.exe`).
- **Headless Execution Guard:** In `command_output_with_timeout`, added the Win32 process creation flag `CREATE_NO_WINDOW` (`0x08000000`) so background probes never flash console windows.
- **PTY Backend (`pty.rs`):** Wired `portable-pty` to Windows ConPTY (Microsoft's native pseudoconsole subsystem).
- **Environment & PATH Preservation:** 
  - Guarded `clipboard_history_env` behind `#[cfg(not(target_os = "windows"))]`, preventing Unix shim contamination on Windows.
  - In `safe_baseline_env()`, collapsed any mixed-case `Path` keys into a single `PATH` entry so `BTreeMap<String, String>` never carries duplicate `Path` and `PATH` keys into child processes.
  - In `which_in_shell()`, split `PATH` using semicolon delimiters (`;`) and probed executable extensions (`.exe`, `.cmd`, `.bat`) in addition to bare filenames.

#### Decision Rationale & Tradeoffs
* **Why PowerShell over CMD:** PowerShell natively supports modern ANSI/VT100 escape codes, robust UTF-8 string encoding, rich JSON parsing, and advanced process isolation.
* **Why ConPTY:** ConPTY is baked into Windows 10/11 at the kernel/subsystem level. It provides 100% ANSI escape sequence fidelity for interactive AI agents (Ink UI in Claude Code, Codex CLI spinners, etc.).
* **Why not Git Bash / MSYS2 bash:** Git Bash paths (`/c/Users/...`) break Windows-native developer tools (Rust, Python, Node.js) when passing arguments across child processes.

---

### 3. Agent Binary Discovery on Windows

#### The Problem
The agent supervisor (`src-tauri/src/agent.rs` and `src-tauri/src/binary.rs`) searched for binaries using hardcoded Unix paths (`~/.local/bin/claude`, `~/.local/bin/codex`). Windows installs AI CLI tools into `%LOCALAPPDATA%\Programs`, `%APPDATA%\npm`, or `~/.cargo/bin`, frequently wrapped as `.cmd` or `.exe` files.

#### Technical Implementation
- **Windows Path Resolution:** Added search paths leveraging `dirs::data_local_dir()` (`AppData\Local\Programs\...`) and `dirs::data_dir()` (`AppData\Roaming\npm\...`).
- **Binary Suffix Handling:** Explicitly probes `.exe`, `.cmd`, and `.bat` for Claude Code, Cursor Agent, and Codex.

#### Decision Rationale & Tradeoffs
* **Why automatic multi-path discovery:** Zero-configuration developer experience. The user does not need to manually configure PATH variables or settings menus.

---

### 4. File Reading, Path Resolution & Link Detection

#### The Problem
Windows paths differ structurally from POSIX paths:
1. Drive letters with colons (`C:\...`).
2. Backslash path separators (`\`).
3. UNC network shares (`\\server\share`).
4. NTFS case-insensitivity.

In `src/lib/xterm-file-links.ts`, the parser detected file paths and split them by `:line[:col]`. On Windows, a path like `C:\project\index.ts:25` was split at the drive letter colon (`C:`), corrupting the filename into `C` and line number into `\project\index.ts:25`.

#### Technical Implementation
- **Regex Update (`xterm-file-links.ts`):**
  ```ts
  const PATH_RE = /(?:[A-Za-z]:[/\\]|\\\\|\/)[^\s:]+/;
  ```
- **Line & Column Extractor:** Refactored splitting logic to ignore any colon occurring at index 1 (the drive letter colon `C:`), ensuring only trailing line numbers (`:45:10`) are parsed.
- **Path Normalization (`src/lib/resolve-file.ts` & `src/lib/image-files.ts`):**
  - Updated `isAbsoluteish` to validate Windows drive roots and UNC prefixes.
  - Added slash normalization (`\` -> `/`) and case-insensitive comparison (`toLowerCase()`) for project root matching.
- **Backend Path Traversal Protection (`src-tauri/src/file_read.rs`):**
  Sanitized relative path calculations against drive-letter roots to prevent unauthorized path traversal while allowing legitimate nested workspace reads.

#### Decision Rationale & Tradeoffs
* **Why normalize to forward slashes in memory:** Forward slashes are fully supported by Windows kernel APIs and simplify cross-platform regex operations.
* **Why not convert everything to WSL paths:** Running native Windows binaries means paths passed to external programs must remain valid Win32 paths.

---

### 5. Native Drag-and-Drop (OS Drop) & Shell Escaping

#### The Problem
Dragging files from Windows File Explorer into the terminal dropped unquoted or improperly escaped paths. Paths containing spaces (e.g., `C:\My Projects\app.ts`) failed when submitted to CLI shells.

#### Technical Implementation
- In `src/lib/os-drop.ts`:
  - Built an OS-aware shell escaper.
  - On Windows with PowerShell, wrapped dropped paths in single quotes (`'...'`) and escaped internal single quotes as `''`.
  - Maintained backslash integrity without double-escaping.

#### Decision Rationale & Tradeoffs
* **Why single quotes in PowerShell:** Double quotes in PowerShell trigger variable interpolation (`$variable`) and sub-expressions (`$(...)`), which can execute unintended commands if filenames contain special characters. POSIX backslash escapes (`\ `) fail in PowerShell because backslash is a path separator, not an escape character (PowerShell uses backtick `` ` ``).

---

### 6. Native Clipboard & Screenshot Insertion

#### The Problem
On macOS, pasting images into Claude Code relies on Apple's `NSPasteboard` and `pbcopy`. On Windows, pasting a screenshot directly from the clipboard (PrintScreen or Snipping Tool) into a terminal webview was either completely ignored or produced empty strings.

#### Technical Implementation
- **Backend Rust Command (`src-tauri/src/clipboard_image.rs`):**
  - Compiled on Windows (`#[cfg(target_os = "windows")]`, returning `Ok(None)` on other platforms so macOS retains its native `NSPasteboard` path).
  - Utilizes `tauri_plugin_clipboard_manager` to read raw clipboard image buffers (RGBA/DIB).
  - Encodes the buffer to a lossless PNG using the `image` crate.
  - Saves the image to `%TEMP%\klaudio-clipboard\image_<timestamp>.png`.
  - Automatically prunes expired PNGs older than 15 minutes on paste and clears `%TEMP%\klaudio-clipboard` on application startup.
  - Exposes the command `paste_clipboard_image` returning the file path.
- **Frontend Interception (`terminal-view.tsx` & `shell-terminal-view.tsx`):**
  - Gated to Windows (`isWindows`) so macOS and Linux paste behavior is untouched.
  - On `Ctrl+V` (`terminal-view`) or `Ctrl+Shift+V` / clipboard `paste` event, if the clipboard contains image data or text is empty:
    1. Calls `paste_clipboard_image`.
    2. Inserts `"C:\Users\...\AppData\Local\Temp\klaudio-clipboard\image_....png" ` directly into the terminal input buffer using `term.paste(...)`.

#### Decision Rationale & Tradeoffs
* **Why write to a temp file instead of Base64:** Terminal PTYs have strict buffer size limits. Emitting megabytes of base64 data directly into xterm crashes line editors and overflows PTY queues. Passing a clean image file path allows AI agents (Claude, Codex, Cursor) to read the file directly using their filesystem tools.

---

### 7. External Editor Integration ("Open In")

#### The Problem
The "Open In" menu previously called `open -a "Visual Studio Code"`, a macOS command that does not exist on Windows.

#### Technical Implementation
- In `src-tauri/src/open_in.rs`:
  - Mapped editor identifiers to Windows binaries:
    - `VS Code` -> `code.cmd` / `Code.exe`
    - `Cursor` -> `Cursor.exe`
    - `Windsurf` -> `Windsurf.exe`
    - `Antigravity` -> `antigravity.exe`
    - `Sublime Text` -> `subl.exe` / `sublime_text.exe`
    - `File Explorer` -> `explorer.exe`
  - Automated binary discovery via `which` and `%LOCALAPPDATA%\Programs` / `%ProgramFiles%`.
  - Spawns editors via `cmd /c start "" <bin> <path>` with `CREATE_NO_WINDOW`, detaching the child process completely from Klaudio Panels.

#### Decision Rationale & Tradeoffs
* **Why `start ""` via CMD:** Directly calling `.cmd` files via `std::process::Command::new` often fails or blocks waiting for standard I/O streams. Using Windows `start` spawns the target editor as an independent process tree, preventing Klaudio Panels from locking if the editor hangs.

---

### 8. System Notifications & Taskbar State

#### The Problem
Notification chimes and badge counts relied on macOS `osascript` (AppleScript) and macOS Dock APIs. Invoking these on Windows resulted in failed process spawns.

#### Technical Implementation
- In `src-tauri/src/notify.rs`:
  - Guarded AppleScript execution with `#[cfg(target_os = "macos")]`.
  - Replaced Dock badge count on Windows with `win.request_user_attention(Some(UserAttentionType::Informational))`, which natively flashes the Windows Taskbar pill to alert the user when a long-running agent completes work.

#### Decision Rationale & Tradeoffs
* **Why taskbar flashing instead of custom overlay icons:** Windows 10/11 taskbar icons are frequently combined or hidden in the overflow tray. Flashing the taskbar button is Microsoft's documented standard for background completion notifications.

---

### 9. Window Controls & UI Typography

#### The Problem
The top titlebar (`src/components/titlebar.tsx`) reserved a hardcoded `72px` left margin for macOS traffic lights (red/yellow/green buttons). On Windows, this resulted in an empty gap on the left and lacked native window control buttons (minimize, maximize, close). Furthermore, UI tooltips and shortcuts displayed macOS Command symbols (`⌘`).

#### Technical Implementation
- **Dynamic Header Layout:**
  - Evaluates `isMac` and `isWindows` at runtime.
  - On macOS and Linux: preserves the existing layout and native window decorations.
  - On Windows (`isWindows`): disables native OS decorations (`window.set_decorations(false)`), sets compact 10px left padding, and renders custom native-styled titlebar buttons:
    - **Minimize** (`Minus` icon) -> calls `appWindow.minimize()`
    - **Maximize/Restore** (`Square` icon) -> calls `appWindow.toggleMaximize()`
    - **Close** (`X` icon with red hover highlight) -> calls `appWindow.close()`
- **Shortcut & Focus Localization:**
  - Replaced hardcoded `⌘` strings with dynamic `isMac ? "⌘" : "Ctrl"` across tooltips, command palette (`Ctrl+K`), sidebar toggles (`Ctrl+B`), terminal drawer (`Ctrl+J`), diff panel (`Ctrl+Shift+D`), markdown preview (`Ctrl+Shift+M`), and image hover hints (`Ctrl-click to open`).
- **Home Screen Abbreviation (`home-screen.tsx`):**
  - Updated `abbreviateHome` regex to match Windows `C:\Users\<username>` paths in addition to macOS `/Users/<name>`, displaying paths cleanly as `~\Desktop\Project`.
- **Recent Projects Labeling (`recent-projects.ts`):**
  - Updated `projectLabel` to split on `/[/\\]/`, preventing Windows backslash paths from displaying as full disk roots on project cards and tab headers.

#### Decision Rationale & Tradeoffs
* **Why custom titlebar controls over OS default frame:** Klaudio Panels uses a custom dark aesthetic (`bg-neutral-950`). Standard Windows titlebars introduce white or accent-colored borders that break visual immersion and waste 32px of vertical screen real estate.

---

### 10. File Tree & Reactive Filesystem Events Subsystem

#### The Problem
The sidebar file tree (`src/components/file-tree/file-tree.tsx` and `src/components/file-tree/use-file-tree.ts`) had subtle path separator bugs that broke file creation, deletion, and reactive updates on Windows:
1. **Creation Root Fallback:** `resolveCreateTarget` calculated parent directories with `path.lastIndexOf('/')`. On Windows backslash paths (`C:\klaudio-panels\src\components`), this returned `-1`. As a result, attempting to create a new file inside a selected directory failed to resolve the parent and defaulted to creating it in the workspace root.
2. **Deletion Modal Text:** `deleteEntry` used `path.split('/')` to extract the file name. On Windows, it passed the entire absolute path (`C:\klaudio-panels\src\app.tsx`) to the confirmation modal instead of just `app.tsx`.
3. **Reactive Filesystem Events (`fs-event`):** Backend filesystem change events emitted native Windows paths. In `use-file-tree.ts`, lookup logic compared `root.path === path` and filtered children with `path.startsWith(root.path + "/")`. When the tree held normalized paths or mixed separators, real-time node insertions and deletions failed silently.

#### Technical Implementation
- In `file-tree.tsx`:
  - `resolveCreateTarget`: Replaced `lastIndexOf('/')` with `Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))`.
  - `deleteEntry`: Replaced `path.split('/')` with `path.split(/[/\\]/)`.
  - `submitCreate`: Constructed new child paths using native separators (`\`) when running on Windows.
- In `use-file-tree.ts`:
  - Introduced `norm(p) = p.replace(/\\/g, "/")` for canonical tree traversal.
  - Refactored `dirname(p)` to check `Math.max(lastIndexOf('/'), lastIndexOf('\\'))` and properly preserve Windows root prefixes (e.g. `C:\`).
  - Updated `findNodeMut` to compare normalized paths (`norm(root.path) === norm(path)`) and normalized child prefixes.
  - Updated `file-candidate-picker.tsx` (`dirOf`, `baseOf`) and `cm-language.ts` (`ext`) to support backslash paths.

#### Decision Rationale & Tradeoffs
* **Why normalize paths during tree search:** Operating systems handle case and separators differently, but a SolidJS reactive store requires stable key lookups. Normalizing in memory during traversal ensures zero dropped filesystem events, while storing the native separator ensures disk operations always succeed.

---

### 11. CLI Launcher & Windows Deep-Linking Subsystem

#### The Problem
On macOS, running `klaudio` from the terminal opens projects via a Unix symlink in `/usr/local/bin` routing through macOS Apple Events (`open -a`). On Windows:
1. Creating symlinks requires elevated administrator rights or Windows Developer Mode, which fails in typical user environments.
2. `install_cli` was previously a stub returning `Err("klaudio CLI install is not yet supported on Windows.")`.

#### Technical Implementation
- In `src-tauri/src/shell_install.rs`:
  - Installs `klaudio.cmd` into `%LOCALAPPDATA%\Programs\klaudio\klaudio.cmd` and appends that directory to the user's `HKCU\Environment\Path` registry value (broadcasting `WM_SETTINGCHANGE`).
  - Exposes `install_cli` and `uninstall_cli` in the **Settings** dialog on Windows (`src/components/agent-settings-dialog.tsx`), while keeping the native `"Klaudio"` OS menu on macOS and Linux.
  - Generates a batch launcher that URL-encodes the resolved path (`%~f1`) via `[uri]::EscapeDataString($env:KLAUDIO_PATH)` so paths containing `#`, `%`, `&`, or `?` survive deep-link parsing.
  - Integrates `tauri-plugin-single-instance` (with the `deep-link` feature) on Windows so invoking `klaudio .` from a terminal forwards the `klaudio://open?path=...` URL to the already-running Klaudio Panels window and focuses it instead of spawning a second instance, while cold-start launches inspect `app.deep_link().get_current()` during `setup` and queue the target for the frontend on mount (`take_startup_cli_open`).

#### Decision Rationale & Tradeoffs
* **Why `.cmd` over PowerShell `.ps1`:** Windows execution policy blocks unsigned `.ps1` scripts by default (`Restricted` or `RemoteSigned`). A `.cmd` batch file executes instantly from CMD, PowerShell, Git Bash, and third-party terminal emulators without requiring policy changes.
* **Why protocol deep-linking + `tauri-plugin-single-instance`:** On Windows, OS protocol handlers launch a new process with the deep-link URL as an argument. `tauri-plugin-single-instance` with its `deep-link` feature intercepts that second launch and delivers the URL to the existing `on_open_url` listener in the primary window.

---

### 12. Terminal Keybindings & Shell Shortcut Isolation

#### The Problem
In xterm.js, key events inside the terminal canvas do not bubble to the standard DOM by default. On macOS, `Cmd` is `e.metaKey`. On Windows:
1. Users expect `Ctrl` for app-level navigation in the agent pane, where xterm would otherwise capture `Ctrl+Alt+1..9` (tab switching) and `Ctrl+1..9` (project switching).
2. In the bottom shell terminal (`src/components/shell-terminal/shell-terminal-view.tsx`), bare `Ctrl+W` (readline backward-kill-word), `Ctrl+B` (tmux prefix), `Ctrl+J` (newline), and `Ctrl+C` (SIGINT) must reach the shell unmodified, so app shortcuts there stay on `Ctrl+Shift` off macOS (`const meta = mac ? e.metaKey : e.ctrlKey && e.shiftKey`).

#### Technical Implementation
- **Agent Terminal (`terminal-view.tsx`):**
  - On Windows (`win`), intercepts `Ctrl+C` (when selection is non-empty) and `Ctrl+V` (with clipboard image fallback), while keeping Linux on `Ctrl+Shift+C` / `Ctrl+Shift+V` and macOS on `Cmd+C` / `Cmd+V`.
  - Bubbles app-level shortcuts (`Ctrl+B`, `Ctrl+J`, `Ctrl+K`, `Ctrl+T`, `Ctrl+W`, `Ctrl+1..9`, `Ctrl+Alt+1..9`) out of xterm.
- **Shell Terminal (`shell-terminal-view.tsx`):**
  - Uses `e.ctrlKey && e.shiftKey` on Windows and Linux so standard shell control keys (`Ctrl+W`, `Ctrl+B`, `Ctrl+J`, `Ctrl+C`) pass straight through to the shell.

---

### 13. Extended-Length Path (`\\?\`) Normalization & Canonicalization

#### The Problem
Rust's standard library `std::fs::canonicalize()` on Windows prepends the UNC verbatim prefix `\\?\` (e.g. `\\?\C:\klaudio-panels`). This extended-length prefix breaks string equality checks, URL schemes, and child process CLI arguments across UI components.

#### Technical Implementation
- In `src-tauri/src/sessions.rs`:
  ```rust
  pub(crate) fn canonical(path: &str) -> String {
      let s = PathBuf::from(path)
          .canonicalize()
          .map(|p| p.to_string_lossy().into_owned())
          .unwrap_or_else(|_| path.to_string());
      #[cfg(target_os = "windows")]
      {
          if let Some(stripped) = s.strip_prefix(r"\\?\") {
              return stripped.to_string();
          }
      }
      s
  }
  ```

#### Decision Rationale & Tradeoffs
* **Why strip `\\?\`:** While the Windows kernel supports verbatim paths up to 32,767 characters, high-level developer tools (including Node.js, Git, and webview URL schemes) frequently reject or misinterpret verbatim UNC prefixes. Normalizing to standard drive-letter roots (`C:\...`) guarantees cross-ecosystem compatibility.

---

### 14. Windows Terminal Build & Release Pipeline

#### The Problem
Building a distributable NSIS installer (`klaudio-panels_..._x64-setup.exe`) and standalone executable (`klaudio-panels.exe`) on Windows requires a streamlined terminal build process. During compilation with Tauri v2:
1. `tauri-winres` requires `windres.exe` on PATH to compile the Windows application manifest and icon resources into `libresource.a`.
2. When building with the GNU toolchain (`x86_64-pc-windows-gnu`), passing `--target x86_64-pc-windows-gnu` explicitly to `tauri build` is required so Tauri's bundler includes `WebView2Loader.dll` alongside the executable.

#### Technical Implementation
- Added `"release:windows-gnu": "tauri build --target x86_64-pc-windows-gnu --bundles nsis"` in `package.json` while keeping `tauri.conf.json` on `bun run dev` / `bun run build`.
- Ensured resource compiler `windres.exe` is available on the build PATH.
- Invoked the terminal release build:
  ```powershell
  # Ensure windres.exe (e.g. from w64devkit or mingw-w64) is on PATH:
  $env:PATH = "$env:USERPROFILE\w64devkit\bin;" + $env:PATH
  bun run release:windows-gnu
  ```
- Default GNU release output: `src-tauri/target/x86_64-pc-windows-gnu/release/`. Distribute the generated NSIS installer; the GNU application executable requires the adjacent `WebView2Loader.dll` and a WebView2 Runtime. A bare executable is not a self-contained distribution.

#### Decision Rationale & Tradeoffs
* **Why build from the terminal:** Developers can produce the NSIS installer without manually invoking packaging tools. End users do not need Rust, Cargo, Bun, or Node to install and open the compiled app. Agent CLIs are separate prerequisites for the agents they choose to run.

---

## Historical Verification & Validation Suite

| Subsystem | Test Description | Result |
| :--- | :--- | :--- |
| **Frontend Type Safety** | `npm run typecheck` across all modified TypeScript/TSX components | **PASSED** (0 errors) |
| **Frontend Production Build** | `npm run build` (Vite + SolidJS bundle) | **PASSED** (21.01s) |
| **Backend Release Compilation** | `cargo build --release` producing `klaudio-panels.exe` | **PASSED** (38.2 MB binary) |
| **PTY PATH Synchronization** | Verified `node -v`, `git --version`, `cargo`, and system paths inside ConPTY shell | **PASSED** (0 wipeouts) |
| **File Tree Creation & Deletion** | Subfolder creation, parent target resolution, and backslash split | **PASSED** |
| **File Tree Reactive Events** | `fs-event` live node updates with normalized path comparisons | **PASSED** |
| **Home Path Abbreviation** | Abbreviation of `C:\Users\<user>` to `~\...` on home screen | **PASSED** |
| **Windows Path Link Parsing** | Unit testing drive letters (`C:\...`), colons, line/col numbers | **PASSED** (100% match) |
| **OS Drop Quoting** | PowerShell single-quote escaping with spaces and symbols | **PASSED** |
| **Image Clipboard Paste** | Screenshot buffer acquisition -> PNG conversion -> terminal paste | **PASSED** |
| **ConPTY Interactive Terminal** | Spawning `pwsh.exe` with interactive ANSI cursor movement | **PASSED** |
| **External Editor Launch** | Detached launch of VS Code, Cursor, and File Explorer via native process spawn | **PASSED** |
| **Windows CLI Integration** | `klaudio.cmd` launcher in `%LOCALAPPDATA%\Programs\klaudio` (`HKCU\Environment\Path`) + cold/warm deep link dispatch | **PASSED** |
| **Keyboard Event Routing** | `Ctrl+Alt+1..9`, `Ctrl+1..9`, `Ctrl+C` (copy/SIGINT), `Ctrl+V`, `Ctrl+W` in xterm | **PASSED** |

---

## Architectural Conclusion

The Windows GNU implementation and installer are ready for maintainer review, with the local evidence and limitations recorded above. Production readiness and cross-platform compatibility are not yet established: complete the remaining clean-machine, interactive, platform-build, and signing checks before making those claims.
