import { onCleanup, onMount, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTerminal } from "@/context/terminal";

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

export function TerminalView() {
  const ctx = useTerminal();
  let container: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let resizeObs: ResizeObserver | undefined;
  let detachData: (() => void) | undefined;
  let detachExit: (() => void) | undefined;
  let fitDebounce: number | undefined;

  const encoder = new TextEncoder();

  onMount(() => {
    term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.2,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      convertEol: false,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container!);
    requestAnimationFrame(() => fit?.fit());

    term.onData((data) => {
      void ctx.write(encoder.encode(data));
    });
    term.onResize(({ cols, rows }) => {
      void ctx.resize(cols, rows);
    });

    // Cmd+C / Cmd+V / Cmd+K handling. Returning false means xterm will NOT
    // forward the key to the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mac = navigator.platform.toUpperCase().includes("MAC");
      const meta = mac ? e.metaKey : e.ctrlKey && e.shiftKey;
      if (!meta) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term!.hasSelection()) {
        // Let the browser copy the selection; don't send Ctrl/Cmd-C to PTY.
        navigator.clipboard
          .writeText(term!.getSelection())
          .catch((err) => console.warn("clipboard write failed", err));
        return false;
      }
      if (key === "v") {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) void ctx.write(encoder.encode(text));
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

    detachData = ctx.onData((bytes) => {
      term?.write(bytes);
    });
    detachExit = ctx.onExit((code) => {
      term?.writeln(
        `\x1b[2m\r\n[claude exited with code ${code}]\x1b[0m`,
      );
    });

    resizeObs = new ResizeObserver(() => {
      if (fitDebounce) window.clearTimeout(fitDebounce);
      fitDebounce = window.setTimeout(() => fit?.fit(), 50);
    });
    resizeObs.observe(container!);
  });

  onCleanup(() => {
    resizeObs?.disconnect();
    if (fitDebounce) window.clearTimeout(fitDebounce);
    detachData?.();
    detachExit?.();
    term?.dispose();
    void ctx.kill();
  });

  return (
    <div class="h-full w-full flex flex-col min-h-0">
      <div ref={container} class="flex-1 min-h-0 p-2" />
      <Show when={ctx.store.error}>
        <div class="border-t border-red-900/50 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300 font-mono">
          {ctx.store.error}
        </div>
      </Show>
      <Show when={ctx.store.status === "exited" && ctx.store.id === null}>
        <div class="border-t border-neutral-800 bg-neutral-900/50 px-3 py-1.5 text-[11px] text-neutral-500 font-mono">
          PTY cerrado (código {ctx.store.exitCode ?? "?"}). Abre una sesión nueva.
        </div>
      </Show>
    </div>
  );
}
