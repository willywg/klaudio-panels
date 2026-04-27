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
import { useShellPty } from "@/context/shell-pty";
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
  ptyId: string;
  active: boolean;
};

export function ShellTerminalView(props: Props) {
  const ctx = useShellPty();
  let container: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let resizeObs: ResizeObserver | undefined;
  let detachData: (() => void) | undefined;
  let detachExit: (() => void) | undefined;
  let scrollDisposable: { dispose: () => void } | undefined;
  let fitDebounce: number | undefined;
  let disposed = false;

  const [isScrolledUp, setIsScrolledUp] = createSignal(false);

  function scrollToBottom() {
    term?.scrollToBottom();
  }

  const encoder = new TextEncoder();

  function safeFit() {
    if (disposed || !fit || !container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    try {
      fit.fit();
    } catch (err) {
      console.warn("shell fit failed", err);
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
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(new WebLinksAddon(openUrlInSystemBrowser));

    term.open(container!);
    term.unicode.activeVersion = "11";

    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl?.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL unavailable for shell; using canvas.", err);
    }

    requestAnimationFrame(() => safeFit());
    // Second fit after the resize handle + tab strip have settled.
    window.setTimeout(() => safeFit(), 180);

    term.onData((data) => {
      void ctx.write(props.ptyId, encoder.encode(data));
    });
    term.onResize(({ cols, rows }) => {
      void ctx.resize(props.ptyId, cols, rows);
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
        // Tauri plugin bypasses WebKit's "Paste" permission bubble.
        // term.paste() handles bracketed paste when the PTY enables it.
        // preventDefault() is critical — without it WebKit also fires
        // its native paste into xterm's hidden textarea and the shell
        // receives the clipboard text twice (same fix Claude view got
        // in v0.9.3).
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
      // Editing" preset). Works in bash/zsh/fish line editors via
      // Ctrl+A / Ctrl+E.
      if (key === "arrowleft") {
        e.preventDefault();
        void ctx.write(props.ptyId, encoder.encode("\x01"));
        return false;
      }
      if (key === "arrowright") {
        e.preventDefault();
        void ctx.write(props.ptyId, encoder.encode("\x05"));
        return false;
      }
      // Cmd+J / Cmd+W / Cmd+B are app-level; don't forward a literal letter
      // into the PTY when the global handler is about to claim it.
      if (key === "j" || key === "w" || key === "b") return false;
      return true;
    });

    scrollDisposable = term.onScroll(() => {
      if (!term || disposed) return;
      const buf = term.buffer.active;
      setIsScrolledUp(buf.viewportY < buf.baseY);
    });
    registerTerminalScroller(props.ptyId, scrollToBottom);

    detachData = ctx.onData(props.ptyId, (bytes) => {
      if (disposed) return;
      try {
        term?.write(bytes);
      } catch (err) {
        console.warn("shell xterm write failed (non-fatal)", err);
      }
    });
    detachExit = ctx.onExit(props.ptyId, () => {
      // Don't writeln here — the xterm instance may be mid-dispose when the
      // panel auto-closes on last-tab. JSX overlay handles the "exited" notice.
    });

    resizeObs = new ResizeObserver(() => {
      if (fitDebounce) window.clearTimeout(fitDebounce);
      fitDebounce = window.setTimeout(() => safeFit(), 50);
    });
    resizeObs.observe(container!);

    // Mirror terminal-view: ResizeObserver occasionally misses a reflow
    // when the parent flex layout settles (notably on home → project
    // re-mount), leaving xterm's canvas sized to an earlier 0x0 rect.
    // The synthetic `resize` event App.tsx dispatches on that
    // transition needs this listener to bite on the shell dock too.
    const onWinResize = () => {
      if (disposed) return;
      if (fitDebounce) window.clearTimeout(fitDebounce);
      safeFit();
      window.setTimeout(() => {
        if (disposed) return;
        safeFit();
        try {
          term?.refresh(0, (term?.rows ?? 1) - 1);
        } catch {
          // ignore
        }
      }, 250);
    };
    window.addEventListener("resize", onWinResize);
    onCleanup(() => window.removeEventListener("resize", onWinResize));
  });

  // Same visibility re-fit + refresh + focus dance as the Claude terminal.
  createEffect(() => {
    if (!props.active) return;
    requestAnimationFrame(() => {
      if (disposed) return;
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
    disposed = true;
    resizeObs?.disconnect();
    if (fitDebounce) window.clearTimeout(fitDebounce);
    detachData?.();
    detachExit?.();
    scrollDisposable?.dispose();
    unregisterTerminalScroller(props.ptyId);
    try {
      term?.dispose();
    } catch (err) {
      console.warn("shell term dispose failed", err);
    }
  });

  const tab = () => ctx.getTab(props.ptyId);

  return (
    <div
      class="relative h-full w-full flex flex-col min-h-0 overflow-hidden"
      data-pty-kind="shell"
      data-pty-id={props.ptyId}
    >
      <div
        ref={container}
        onContextMenu={(e) => e.preventDefault()}
        class="flex-1 min-h-0 min-w-0 overflow-hidden p-2"
      />
      <ScrollToBottomButton
        visible={isScrolledUp()}
        onClick={scrollToBottom}
      />
      <Show when={tab()?.error}>
        <div class="border-t border-red-900/50 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300 font-mono">
          {tab()!.error}
        </div>
      </Show>
      <Show when={tab()?.status === "exited"}>
        <div class="border-t border-neutral-800 bg-neutral-900/50 px-3 py-1.5 text-[11px] text-neutral-500 font-mono">
          Shell exited (code {tab()?.exitCode ?? "?"}).
        </div>
      </Show>
    </div>
  );
}
