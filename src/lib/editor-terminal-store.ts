import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrlInSystemBrowser } from "@/lib/open-url";
import { makeBareUrlLinkProvider } from "@/lib/xterm-bare-url-links";
import { recordClip } from "@/lib/record-clip";

/** Editor PTY terminals live HERE, not in the component that shows them.
 *
 *  `EditorPtyView` is mounted from a per-project list inside `DiffPanel`, so
 *  switching project (or closing the panel) unmounts it — while the nvim/helix
 *  process keeps running. When the component owned the `Terminal`, that
 *  unmount disposed it and detached the PTY data handler, which meant:
 *
 *    - every byte the editor emitted while you were away was dropped, and
 *    - coming back created a *second* xterm with an empty buffer, so the pane
 *      rendered blank until something forced a partial redraw — arriving
 *      garbled, because the buffer had holes (#68).
 *
 *  Keeping the terminal (and its data subscription) alive for the PTY's whole
 *  lifetime fixes both: the buffer is always complete, and re-showing the tab
 *  is a `fit()` + `refresh()` away. The component now only owns the DOM slot:
 *  `acquire` parents the host element into it, `release` detaches it again.
 *  `destroy` is the PTY's funeral — see `killEditor`. */

const THEME = {
  background: "#0b0b0c",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  cursorAccent: "#0b0b0c",
  selectionBackground: "#3b3b3f",
  black: "#1e1e1e",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#cdd6f4",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#cba6f7",
  brightCyan: "#94e2d5",
  brightWhite: "#ffffff",
};

const FONT_FAMILY =
  "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace";

/** Strip `ESC [ ? Pn (; Pn)* $ p` DECRQM sequences from the byte stream.
 *  xterm.js 6.x's requestMode handler throws on some of these under prod
 *  minification, so we drop them before they reach the parser. */
export function stripDecrqm(bytes: Uint8Array): Uint8Array {
  const ESC = 0x1b;
  const LBR = 0x5b;
  const QST = 0x3f;
  const DLR = 0x24;
  const P = 0x70;
  let matched = false;
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === ESC && bytes[i + 1] === LBR && bytes[i + 2] === QST) {
      matched = true;
      break;
    }
  }
  if (!matched) return bytes;
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (
      i + 2 < bytes.length &&
      bytes[i] === ESC &&
      bytes[i + 1] === LBR &&
      bytes[i + 2] === QST
    ) {
      let j = i + 3;
      let found = false;
      while (j + 1 < bytes.length && j - i < 64) {
        if (bytes[j] === DLR && bytes[j + 1] === P) {
          found = true;
          break;
        }
        j++;
      }
      if (found) {
        i = j + 2;
        continue;
      }
    }
    out.push(bytes[i]);
    i++;
  }
  return new Uint8Array(out);
}

export type EditorTerminalDeps = {
  onData: (ptyId: string, handler: (bytes: Uint8Array) => void) => () => void;
  write: (ptyId: string, bytes: Uint8Array) => void;
  resize: (ptyId: string, cols: number, rows: number) => void;
};

export type EditorTerminal = {
  ptyId: string;
  /** Element the Terminal is `open()`ed into. Re-parented on every acquire. */
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  /** Set once `pty_open_editor` has been kicked off for this PTY. Lives here
   *  rather than in the component so a remount can't spawn a second child on
   *  the same id — which used to leave two editors writing to one channel. */
  spawned: boolean;
};

const terminals = new Map<string, EditorTerminal>();
const teardowns = new Map<string, () => void>();

const encoder = new TextEncoder();

/** Get the terminal for `ptyId`, creating it on first call, and parent its
 *  host element into `container`. Returns `{ entry, created }` so the caller
 *  can tell a first mount (needs the initial fit + spawn) from a remount
 *  (needs a repaint from the existing buffer). */
export function acquireEditorTerminal(
  ptyId: string,
  container: HTMLElement,
  deps: EditorTerminalDeps,
): { entry: EditorTerminal; created: boolean } {
  const existing = terminals.get(ptyId);
  if (existing) {
    container.appendChild(existing.host);
    return { entry: existing, created: false };
  }

  const host = document.createElement("div");
  host.style.height = "100%";
  host.style.width = "100%";
  container.appendChild(host);

  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: 13,
    lineHeight: 1.0,
    letterSpacing: 0,
    theme: THEME,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10_000,
    convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.loadAddon(new WebLinksAddon(openUrlInSystemBrowser));

  term.open(host);
  term.unicode.activeVersion = "11";

  // Bare-URL provider (see xterm-bare-url-links.ts). Editor PTYs (nvim/
  // helix) don't have file-link match conflicts to worry about — this is
  // purely for the convenience of clicking a bare domain that appears in
  // an editor buffer.
  const bareUrl = term.registerLinkProvider(makeBareUrlLinkProvider(term));

  let webgl: WebglAddon | undefined;
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl?.dispose());
    term.loadAddon(webgl);
  } catch (err) {
    console.warn("WebGL renderer unavailable for editor; using canvas.", err);
  }

  term.onData((data) => deps.write(ptyId, encoder.encode(data)));
  term.onResize(({ cols, rows }) => deps.resize(ptyId, cols, rows));

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // App-level tab-switch combos — bubble to the window handler, but
    // keep xterm from forwarding \t / a layout dead-char to the editor.
    if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
      return false;
    }
    if (e.metaKey && e.altKey && /^Digit[1-9]$/.test(e.code)) {
      return false;
    }
    const mac = navigator.platform.toUpperCase().includes("MAC");
    const meta = mac ? e.metaKey : e.ctrlKey && e.shiftKey;
    if (!meta) return true;
    const key = e.key.toLowerCase();
    if (key === "c" && term.hasSelection()) {
      recordClip(term.getSelection());
      navigator.clipboard
        .writeText(term.getSelection())
        .catch((err) => console.warn("clipboard write failed", err));
      return false;
    }
    if (key === "v") {
      // Tauri plugin avoids WebKit's "Paste" permission popup.
      // term.paste() wraps in bracketed-paste markers so nvim/helix get a
      // clean paste instead of char-by-char typing (which would trigger
      // indentation + autocomplete on every line).
      readClipboardText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch((err) => console.warn("clipboard read failed", err));
      return false;
    }
    // Swallow Cmd+W so the app-level handler closes the editor tab cleanly
    // instead of xterm.js seeing the keydown.
    if (key === "w") return false;
    return true;
  });

  // The subscription belongs to the terminal, not to whoever is showing it:
  // bytes must keep landing in the buffer while the tab is off-screen.
  const detachData = deps.onData(ptyId, (bytes) => {
    // nvim probes terminal capabilities with DECRQM (CSI ? Pn $ p) sequences
    // at startup (modes 2026/2027/2031/2048). xterm.js 6.x's requestMode()
    // handler throws on some of these, killing the render pipeline in the
    // minified production bundle. Strip them before handing bytes to xterm
    // — they're purely advisory probes nvim uses to detect modern terminal
    // features; losing the reply just means nvim falls back to legacy
    // behavior (same as running inside iTerm a few years ago).
    try {
      term.write(stripDecrqm(bytes));
    } catch (err) {
      console.warn("xterm write failed (non-fatal)", err);
    }
  });

  const entry: EditorTerminal = { ptyId, host, term, fit, spawned: false };
  terminals.set(ptyId, entry);
  teardowns.set(ptyId, () => {
    detachData();
    bareUrl.dispose();
    host.remove();
    try {
      term.dispose();
    } catch (err) {
      console.warn("editor term dispose failed", err);
    }
  });
  return { entry, created: true };
}

/** Detach the host element from the DOM but keep the terminal — and its PTY
 *  subscription — alive. Called when the view unmounts. */
export function releaseEditorTerminal(ptyId: string): void {
  terminals.get(ptyId)?.host.remove();
}

/** Tear the terminal down for good. Only correct once the PTY itself is gone,
 *  so it is called from `killEditor`. */
export function destroyEditorTerminal(ptyId: string): void {
  const teardown = teardowns.get(ptyId);
  teardowns.delete(ptyId);
  terminals.delete(ptyId);
  teardown?.();
}
