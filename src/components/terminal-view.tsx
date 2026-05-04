import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  readText as readClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { useTerminal } from "@/context/terminal";
import { useDiffPanel } from "@/context/diff-panel";
import { makeFileLinkProvider } from "@/lib/xterm-file-links";
import { hoverPtyId } from "@/lib/internal-drag";
import { openUrlInSystemBrowser } from "@/lib/open-url";
import {
  registerTerminalScroller,
  unregisterTerminalScroller,
} from "@/lib/terminal-scroll-bus";
import { ScrollToBottomButton } from "@/components/scroll-to-bottom-button";

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
  let scrollDisposable: { dispose: () => void } | undefined;
  let fitDebounce: number | undefined;

  // Drives the floating scroll-to-bottom button + reflects whether the user
  // is currently reading scrollback. Updated from xterm's onScroll event.
  const [isScrolledUp, setIsScrolledUp] = createSignal(false);

  function scrollToBottom() {
    term?.scrollToBottom();
  }

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
      convertEol: false,
    });
    fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.loadAddon(new WebLinksAddon(openUrlInSystemBrowser));

    term.open(container!);
    term.unicode.activeVersion = "11";

    // Short-circuit DECRQM (`CSI ? <mode> $ p`). xterm.js 6.0.0's shipped
    // bundle has a closure-capture bug in `requestMode` that throws
    // `ReferenceError: Can't find variable: i` under WebKit's stricter
    // scoping, corrupting the parser state and rendering the panel black.
    // Claude Code probes mode 2026 (synchronized output) very early, so the
    // crash hits on first spawn. Returning `true` marks the sequence as
    // handled, the built-in requestMode never runs, Claude gets no reply
    // and falls back to the default ("not supported") path.
    term.parser.registerCsiHandler(
      { prefix: "?", intermediates: "$", final: "p" },
      () => true,
    );

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable; falling back to canvas.", err);
    }

    // Multiple staggered fits — the single rAF call caches a narrow width on
    // the very first project/session load because the split container is
    // still settling (sidebar panel width, diff panel measurements). A
    // follow-up at 180ms + 500ms catches the final width without waiting
    // for the user to resize anything. Same belt-and-suspenders pattern as
    // editor-pty-view.
    document.fonts.ready.then(() => safeFit()).catch(() => {});
    requestAnimationFrame(() => safeFit());
    window.setTimeout(() => safeFit(), 180);
    window.setTimeout(() => safeFit(), 500);

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
      // Shift+Enter → send ESC+CR (`\x1b\r`). Claude Code's prompt reads
      // this as "insert newline" instead of "submit". Warp and iTerm's
      // /terminal-setup do the same translation. preventDefault() is
      // critical — xterm's hidden textarea would otherwise insert `\n`
      // on its own and xterm's input listener would forward a plain `\r`
      // to the PTY before our async write lands, so Claude sees submit
      // first and our ESC-CR arrives too late.
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void ctx.write(props.id, encoder.encode("\x1b\r"));
        return false;
      }
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
        // Read via the Tauri plugin (native macOS pasteboard) instead of
        // navigator.clipboard.readText(), which pops WebKit's "Paste"
        // permission bubble every time. term.paste() wraps the text in
        // bracketed-paste markers when the PTY has ?2004h active so Claude
        // Code can tell pasted input apart from typed input.
        // preventDefault() is critical — without it the webview also fires
        // its native paste into xterm's hidden textarea, xterm forwards
        // those bytes as onData, and the PTY receives the text twice.
        // Always call term.paste(), even with empty text: the bracketed-
        // paste markers alone trigger Claude Code to sniff the NSPasteboard
        // for an image (same path that the WebKit right-click Paste used
        // to reach).
        e.preventDefault();
        readClipboardText()
          .then((text) => term!.paste(text ?? ""))
          .catch((err) => {
            console.warn("clipboard read failed", err);
            term!.paste("");
          });
        return false;
      }
      if (key === "k") {
        term!.clear();
        return false;
      }
      // Cmd+Left/Right → beginning/end of line (iTerm2 "Natural Text
      // Editing" preset, Warp default). Ink's text input (used by
      // Claude Code's prompt) reads Ctrl+A / Ctrl+E as home/end.
      if (key === "arrowleft") {
        e.preventDefault();
        void ctx.write(props.id, encoder.encode("\x01"));
        return false;
      }
      if (key === "arrowright") {
        e.preventDefault();
        void ctx.write(props.id, encoder.encode("\x05"));
        return false;
      }
      return true;
    });

    // Track scroll position so the floating "scroll to bottom" button hides
     // itself once the user is back at the tail. xterm fires onScroll for both
     // user scrolling (wheel, drag) and new-data-pushed-baseY-down, so this
     // signal also catches the "you have new content below" case.
    scrollDisposable = term.onScroll(() => {
      if (!term) return;
      const buf = term.buffer.active;
      setIsScrolledUp(buf.viewportY < buf.baseY);
    });
    registerTerminalScroller(props.id, scrollToBottom);

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
      window.setTimeout(() => {
        safeFit();
        // After a home → project remount the container's final rect
        // arrives late; if fit didn't change cols/rows the onResize
        // callback never fires and Claude gets no SIGWINCH, so nothing
        // repaints the fresh WebGL canvas. Calling refresh here forces
        // xterm to repaint whatever is already in its buffer.
        try {
          if (term) term.refresh(0, term.rows - 1);
        } catch {
          // ignore
        }
      }, 250);
    };
    window.addEventListener("resize", onWinResize);
    onCleanup(() => window.removeEventListener("resize", onWinResize));
  });

  // When the tab becomes visible again do two decoupled things:
  //
  //   1. Force one immediate repaint. WebGL stops painting while the canvas
  //      is `visibility: hidden`; without a refresh the panel stays blank
  //      until something else triggers a redraw. We keep this independent
  //      of fit because fit may legitimately be a no-op (dimensions match).
  //   2. Schedule a single fit at 250ms, after the outer layout has settled
  //      (per-project sidebar width from PR #5, panelLayout memo recompute
  //      from PR #6, diff panel auto-show/hide). The previous staggered
  //      pattern (rAF + 180ms + 500ms) sent up to three SIGWINCHes per
  //      activation: when dimensions changed across stages, each fit forced
  //      Claude to re-paint the alt-screen, drifting xterm's buffer state
  //      and occasionally leaking the welcome banner from the previous-
  //      screen scrollback. One late fit keeps the eventual size correct
  //      while limiting Claude to at most one re-paint. See PRP 016 / #38.
  createEffect(() => {
    if (!props.active) return;

    try {
      if (term) term.refresh(0, term.rows - 1);
      term?.focus();
    } catch {
      // refresh failures shouldn't block the activation flow.
    }

    const fitTimer = window.setTimeout(() => safeFit(), 250);

    onCleanup(() => {
      window.clearTimeout(fitTimer);
    });
  });

  onCleanup(() => {
    resizeObs?.disconnect();
    if (fitDebounce) window.clearTimeout(fitDebounce);
    detachData?.();
    detachExit?.();
    linkDisposable?.dispose();
    scrollDisposable?.dispose();
    unregisterTerminalScroller(props.id);
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

  const isDragOver = () => hoverPtyId() === props.id;

  return (
    <div
      class="h-full w-full flex flex-col min-h-0 overflow-hidden relative"
      data-pty-kind="claude"
      data-pty-id={props.id}
    >
      <div ref={container} class="flex-1 min-h-0 min-w-0 overflow-hidden p-2" />
      <ScrollToBottomButton
        visible={isScrolledUp()}
        onClick={scrollToBottom}
      />
      <Show when={isDragOver()}>
        <div class="absolute inset-1 border-2 border-dashed border-indigo-400/60 rounded pointer-events-none flex items-center justify-center">
          <div class="px-3 py-1.5 rounded bg-indigo-500/20 text-indigo-200 text-[12px] font-medium">
            Drop to insert <span class="font-mono">@file</span> reference
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
          PTY closed (code {tab()?.exitCode ?? "?"}). Close this tab or open another session.
        </div>
      </Show>
    </div>
  );
}
