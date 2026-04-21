import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useTerminal } from "@/context/terminal";
import { useDiffPanel } from "@/context/diff-panel";
import { makeFileLinkProvider } from "@/lib/xterm-file-links";

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

type Props = {
  id: string;
  active: boolean;
};

export function TerminalView(props: Props) {
  const ctx = useTerminal();
  const diffPanel = useDiffPanel();
  let container: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let resizeObs: ResizeObserver | undefined;
  let detachData: (() => void) | undefined;
  let detachExit: (() => void) | undefined;
  let linkDisposable: { dispose: () => void } | undefined;
  let fitDebounce: number | undefined;

  const encoder = new TextEncoder();

  function safeFit() {
    if (!fit || !container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    try {
      fit.fit();
    } catch (err) {
      console.warn("fit failed", err);
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

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable; falling back to canvas.", err);
    }

    requestAnimationFrame(() => safeFit());

    term.onData((data) => {
      // Drop focus-in / focus-out (CSI I / CSI O). xterm.js forwards these
      // whenever our webview's focus changes and `?1004h` is active —
      // which Claude Code enables very early in boot. The PTY is still in
      // ECHO mode during that window, so Claude's tty echoes the bytes
      // back as literal "^[[I" at the top of the screen before Claude
      // flips to raw mode. Claude doesn't actually need these pings, so
      // we just never forward them.
      if (data === "\x1b[I" || data === "\x1b[O") return;
      void ctx.write(props.id, encoder.encode(data));
    });
    term.onResize(({ cols, rows }) => {
      void ctx.resize(props.id, cols, rows);
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
            if (text) void ctx.write(props.id, encoder.encode(text));
          })
          .catch((err) => console.warn("clipboard read failed", err));
        return false;
      }
      if (key === "k") {
        term!.clear();
        return false;
      }
      return true;
    });

    detachData = ctx.onData(props.id, (bytes) => {
      term?.write(bytes);
    });
    detachExit = ctx.onExit(props.id, (code) => {
      term?.writeln(`\x1b[2m\r\n[claude exited with code ${code}]\x1b[0m`);
    });

    // Cmd/Ctrl+click on `src/foo.ts` or `src/foo.ts:42` opens a preview tab.
    // Uses xterm's native link provider API so we never parse the PTY buffer
    // ourselves beyond extracting the text under the cursor.
    const linkProvider = makeFileLinkProvider(term, ({ rel, line }) => {
      const tab = ctx.getTab(props.id);
      if (!tab) return;
      diffPanel.openFile(tab.projectPath, normalizeRel(rel), line);
    });
    linkDisposable = term.registerLinkProvider(linkProvider);

    resizeObs = new ResizeObserver(() => {
      if (fitDebounce) window.clearTimeout(fitDebounce);
      fitDebounce = window.setTimeout(() => safeFit(), 50);
    });
    resizeObs.observe(container!);

    // Safety net for WebKit: the ResizeObserver sometimes fails to fire when
    // a parent flex container reflows (e.g. resizing the window to full
    // screen with the diff panel open). A window-level resize listener plus
    // a follow-up fit 250ms later catches the case where xterm cached a
    // cols=1 measurement from a transient mid-layout width.
    const onWinResize = () => {
      if (fitDebounce) window.clearTimeout(fitDebounce);
      safeFit();
      window.setTimeout(() => safeFit(), 250);
    };
    window.addEventListener("resize", onWinResize);
    onCleanup(() => window.removeEventListener("resize", onWinResize));
  });

  // When the tab becomes visible again, re-measure (size may have changed
  // while hidden), force a full redraw (xterm WebGL stops painting while the
  // canvas is `visibility: hidden` — without refresh the panel stays blank),
  // and refocus so keyboard input lands in the active tab.
  createEffect(() => {
    if (!props.active) return;
    requestAnimationFrame(() => {
      safeFit();
      try {
        if (term) term.refresh(0, term.rows - 1);
        term?.focus();
      } catch {
        // ignore
      }
    });
  });

  onCleanup(() => {
    resizeObs?.disconnect();
    if (fitDebounce) window.clearTimeout(fitDebounce);
    detachData?.();
    detachExit?.();
    linkDisposable?.dispose();
    term?.dispose();
    // NOTE: intentionally NOT calling ctx.closeTab here — unmounting the view
    // (e.g. changing project) is separate from killing the PTY. The shell owns
    // the tab lifecycle.
  });

  const tab = () => ctx.getTab(props.id);

  function normalizeRel(rel: string): string {
    if (rel.startsWith("./")) return rel.slice(2);
    return rel;
  }

  return (
    <div class="h-full w-full flex flex-col min-h-0 overflow-hidden">
      <div ref={container} class="flex-1 min-h-0 min-w-0 overflow-hidden p-2" />
      <Show when={tab()?.error}>
        <div class="border-t border-red-900/50 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300 font-mono">
          {tab()!.error}
        </div>
      </Show>
      <Show when={tab()?.status === "exited"}>
        <div class="border-t border-neutral-800 bg-neutral-900/50 px-3 py-1.5 text-[11px] text-neutral-500 font-mono">
          PTY closed (code {tab()?.exitCode ?? "?"}). Close this tab or open another session.
        </div>
      </Show>
    </div>
  );
}
