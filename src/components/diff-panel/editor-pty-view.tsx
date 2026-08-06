import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { useEditorPty } from "@/context/editor-pty";
import {
  acquireEditorTerminal,
  releaseEditorTerminal,
  type EditorTerminal,
} from "@/lib/editor-terminal-store";
import {
  recordTerminalFocus,
  registerTerminalFocus,
  unregisterTerminalFocus,
} from "@/lib/terminal-focus-bus";

type Props = {
  ptyId: string;
  active: boolean;
  /** Fires ~400ms after the child exits so the user can skim any last
   *  terminal output before the panel tab is spliced. */
  onExit?: (code: number) => void;
};

/** The visible half of an editor PTY. The `Terminal` itself lives in
 *  `editor-terminal-store` and outlives this component — see the note there
 *  for why. This owns the DOM slot, the fit/resize plumbing, and the exit
 *  banner. */
export function EditorPtyView(props: Props) {
  const editorPty = useEditorPty();
  let container: HTMLDivElement | undefined;
  let entry: EditorTerminal | undefined;
  let resizeObs: ResizeObserver | undefined;
  let detachExit: (() => void) | undefined;
  let fitDebounce: number | undefined;
  let onTextareaFocus: (() => void) | undefined;
  let disposed = false;

  function maybeSpawn(_source: string) {
    if (!entry || entry.spawned || disposed) return;
    const cols = entry.term.cols;
    const rows = entry.term.rows;
    // Don't spawn until fit has expanded past the xterm 80x24 default. A
    // first-paint spawn at 80x24 is exactly what caused nvim to freeze its
    // layout under the E5422 press-enter prompt: the first SIGWINCH was
    // delivered while nvim was still in a press-enter modal and dropped.
    if (cols < 2 || rows < 2) return;
    entry.spawned = true;
    void editorPty.spawnPty(props.ptyId, cols, rows);
  }

  function safeFit(source: string) {
    // Racy: ResizeObserver/setTimeout callbacks can fire after onCleanup has
    // released the terminal. Fitting against a detached host measures 0 and
    // would reflow the editor to a garbage size, so bail on both.
    if (disposed || !entry || !container || !entry.host.isConnected) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    try {
      entry.fit.fit();
      maybeSpawn(source);
    } catch (err) {
      console.warn("editor fit failed", source, err);
    }
  }

  /** Repaint the visible rows from the (always complete) buffer. Needed
   *  after every re-attach: the WebGL renderer paints nothing while the host
   *  is detached, so without this the pane comes back blank. */
  function repaint() {
    if (disposed || !entry) return;
    try {
      entry.term.refresh(0, entry.term.rows - 1);
    } catch {
      // ignore
    }
  }

  onMount(() => {
    const acquired = acquireEditorTerminal(props.ptyId, container!, {
      onData: editorPty.onData,
      write: editorPty.write,
      resize: editorPty.resize,
    });
    entry = acquired.entry;

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
    requestAnimationFrame(() => {
      safeFit("onMount-raf");
      repaint();
    });
    window.setTimeout(() => safeFit("onMount-220ms"), 220);
    window.setTimeout(() => safeFit("onMount-600ms"), 600);

    const projectPath = editorPty.getTab(props.ptyId)?.projectPath;
    if (!projectPath) {
      console.error(
        `editor-pty-view: no projectPath for ${props.ptyId}; focus-bus skipped`,
      );
    } else {
      registerTerminalFocus(props.ptyId, projectPath, () => {
        try {
          entry?.term.focus();
        } catch {
          // ignore
        }
      });
      onTextareaFocus = () => recordTerminalFocus(props.ptyId);
      entry.term.textarea?.addEventListener("focus", onTextareaFocus);
    }

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

  // WebGL canvas stops painting while `visibility: hidden` — fit + refresh
  // on re-show. Intentionally NOT calling term.focus() here for the same
  // reason as shell-terminal-view: on project re-entry the editor PTY's
  // active flag flips alongside Claude's, and a focus call here would race
  // with Claude's. xterm's canvas click handler still focuses on direct
  // clicks. See PRP 017 / #40.
  createEffect(() => {
    if (!props.active) return;
    requestAnimationFrame(() => {
      safeFit("active-change");
      repaint();
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
    unregisterTerminalFocus(props.ptyId);
    resizeObs?.disconnect();
    if (fitDebounce) window.clearTimeout(fitDebounce);
    detachExit?.();
    if (onTextareaFocus) {
      entry?.term.textarea?.removeEventListener("focus", onTextareaFocus);
    }
    // Detach the host, keep the terminal: the editor process is still alive
    // and its output must keep landing in the buffer.
    releaseEditorTerminal(props.ptyId);
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
