import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useEditorPty } from "@/context/editor-pty";

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
function stripDecrqm(bytes: Uint8Array): Uint8Array {
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

type Props = {
  ptyId: string;
  active: boolean;
  /** Fires ~400ms after the child exits so the user can skim any last
   *  terminal output before the panel tab is spliced. */
  onExit?: (code: number) => void;
};

export function EditorPtyView(props: Props) {
  const editorPty = useEditorPty();
  let container: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let resizeObs: ResizeObserver | undefined;
  let detachData: (() => void) | undefined;
  let detachExit: (() => void) | undefined;
  let fitDebounce: number | undefined;
  let disposed = false;

  const encoder = new TextEncoder();

  let spawnKicked = false;

  function maybeSpawn(_source: string) {
    if (spawnKicked || disposed || !term) return;
    const cols = term.cols;
    const rows = term.rows;
    // Don't spawn until fit has expanded past the xterm 80x24 default. A
    // first-paint spawn at 80x24 is exactly what caused nvim to freeze its
    // layout under the E5422 press-enter prompt: the first SIGWINCH was
    // delivered while nvim was still in a press-enter modal and dropped.
    if (cols < 2 || rows < 2) return;
    spawnKicked = true;
    void editorPty.spawnPty(props.ptyId, cols, rows);
  }

  function safeFit(source: string) {
    // Racy: ResizeObserver/setTimeout callbacks can fire after onCleanup has
    // disposed the Terminal. Calling fit.fit() on a disposed term crashes
    // WebGL's internal state fast enough to take the whole webview with it.
    if (disposed || !fit || !container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    try {
      fit.fit();
      maybeSpawn(source);
    } catch (err) {
      console.warn("editor fit failed", source, err);
    }
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.0,
      letterSpacing: 0,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      convertEol: false,
    });
    fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.loadAddon(new WebLinksAddon());

    term.open(container!);
    term.unicode.activeVersion = "11";

    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl?.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable for editor; using canvas.", err);
    }

    // Fit twice: once on the next frame (usually enough), and once more
    // after 200ms in case the diff panel was still animating open and the
    // first fit ran against a half-sized container.
    // Font metrics on first paint are unreliable — WebKit can report a
    // smaller glyph advance than reality until the system font (SF Mono)
    // has been fully resolved. xterm's FitAddon multiplies cols by the
    // (wrong) advance, returning a fit that looks right numerically but
    // paints a canvas narrower than the container. Waiting for the font
    // set to settle fixes this without hardcoding dimensions.
    document.fonts.ready
      .then(() => {
        if (disposed) return;
        safeFit("fonts-ready");
      })
      .catch(() => {});
    requestAnimationFrame(() => safeFit("onMount-raf"));
    window.setTimeout(() => safeFit("onMount-220ms"), 220);
    window.setTimeout(() => safeFit("onMount-600ms"), 600);

    term.onData((data) => {
      void editorPty.write(props.ptyId, encoder.encode(data));
    });
    term.onResize(({ cols, rows }) => {
      void editorPty.resize(props.ptyId, cols, rows);
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mac = navigator.platform.toUpperCase().includes("MAC");
      const meta = mac ? e.metaKey : e.ctrlKey && e.shiftKey;
      if (!meta) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term!.hasSelection()) {
        navigator.clipboard
          .writeText(term!.getSelection())
          .catch((err) => console.warn("clipboard write failed", err));
        return false;
      }
      if (key === "v") {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) void editorPty.write(props.ptyId, encoder.encode(text));
          })
          .catch((err) => console.warn("clipboard read failed", err));
        return false;
      }
      // Swallow Cmd+W so the app-level handler closes the editor tab cleanly
      // instead of xterm.js seeing the keydown.
      if (key === "w") return false;
      return true;
    });

    detachData = editorPty.onData(props.ptyId, (bytes) => {
      if (disposed) return;
      // nvim probes terminal capabilities with DECRQM (CSI ? Pn $ p) sequences
      // at startup (modes 2026/2027/2031/2048). xterm.js 6.x's requestMode()
      // handler throws on some of these, killing the render pipeline in the
      // minified production bundle. Strip them before handing bytes to xterm
      // — they're purely advisory probes nvim uses to detect modern terminal
      // features; losing the reply just means nvim falls back to legacy
      // behavior (same as running inside iTerm a few years ago).
      const clean = stripDecrqm(bytes);
      try {
        term?.write(clean);
      } catch (err) {
        console.warn("xterm write failed (non-fatal)", err);
      }
    });
    detachExit = editorPty.onExit(props.ptyId, (code) => {
      // DON'T writeln here — writing into xterm while the child's final
      // burst of ANSI is still being parsed races with the dispose that
      // auto-close triggers a moment later and can crash the WebKit
      // renderer. The banner in the JSX overlay handles the "exited"
      // notice instead.
      window.setTimeout(() => {
        if (disposed) return;
        props.onExit?.(code);
      }, 500);
    });

    resizeObs = new ResizeObserver(() => {
      if (fitDebounce) window.clearTimeout(fitDebounce);
      fitDebounce = window.setTimeout(() => safeFit("resize-observer"), 50);
    });
    resizeObs.observe(container!);
  });

  // WebGL canvas stops painting while `visibility: hidden` — same pattern as
  // terminal-view.tsx: fit + refresh + focus on re-show.
  createEffect(() => {
    if (!props.active) return;
    requestAnimationFrame(() => {
      if (disposed) return;
      safeFit("active-change");
      try {
        if (term) term.refresh(0, term.rows - 1);
        term?.focus();
      } catch {
        // ignore
      }
    });
  });

  // When the PTY transitions opening → running the nvim splash is about to
  // render. Force one more fit so nvim gets accurate cols/rows in its very
  // first SIGWINCH instead of the 80x24 default.
  createEffect(() => {
    if (tab()?.status === "running") {
      requestAnimationFrame(() => safeFit("status-running"));
    }
  });

  onCleanup(() => {
    disposed = true;
    resizeObs?.disconnect();
    if (fitDebounce) window.clearTimeout(fitDebounce);
    detachData?.();
    detachExit?.();
    try {
      term?.dispose();
    } catch (err) {
      console.warn("editor term dispose failed", err);
    }
  });

  const tab = () => editorPty.getTab(props.ptyId);

  return (
    <div class="relative h-full w-full flex flex-col min-h-0 overflow-hidden">
      <div
        ref={container}
        // Block the WebView's native "Cut/Copy/Paste/Writing Tools" menu so
        // right-click passes through to xterm/nvim instead (nvim renders its
        // own popup menu when `set mouse=a` is active).
        onContextMenu={(e) => e.preventDefault()}
        class="flex-1 min-h-0 min-w-0 overflow-hidden p-2"
      />
      <Show when={tab()?.status === "opening"}>
        <div class="absolute inset-0 flex items-center justify-center bg-neutral-950/80 pointer-events-none">
          <div class="flex items-center gap-2.5 text-[12px] text-neutral-400">
            <div class="w-3.5 h-3.5 border-2 border-neutral-700 border-t-emerald-400 rounded-full animate-spin" />
            <span>Starting {tab()?.editorId}…</span>
          </div>
        </div>
      </Show>
      <Show when={tab()?.error}>
        <div class="border-t border-red-900/50 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300 font-mono">
          {tab()!.error}
        </div>
      </Show>
      <Show when={tab()?.status === "exited"}>
        <div class="border-t border-neutral-800 bg-neutral-900/50 px-3 py-1.5 text-[11px] text-neutral-500 font-mono">
          Editor exited (code {tab()?.exitCode ?? "?"}). Close this tab to dismiss.
        </div>
      </Show>
    </div>
  );
}
