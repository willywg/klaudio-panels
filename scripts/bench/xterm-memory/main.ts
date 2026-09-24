import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

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

const CHUNK = 64 * 1024;

const params = new URLSearchParams(location.search);
const n = Math.max(1, Number(params.get("n") ?? "1"));
const renderer = params.get("renderer") === "dom" ? "dom" : "webgl";
const fill = Math.max(0, Number(params.get("fill") ?? "0"));
const cols = Math.max(1, Number(params.get("cols") ?? "200"));
const rows = Math.max(1, Number(params.get("rows") ?? "50"));
const scrollback = Math.max(0, Number(params.get("scrollback") ?? "10000"));

const lostIdx: number[] = [];

function twoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function agentLine(i: number): string {
  const color = [2, 4, 6, 3, 5, 1, 14, 12][i % 8];
  const cjk = ["终端", "記憶", "测量", "漢字", "画面"][i % 5];
  const emoji = ["✅", "⚠️", "🔧", "📦", "🚀"][i % 5];
  const prefix = `\x1b[1m\x1b[38;5;${color}m[${String(i).padStart(5, "0")}]\x1b[0m `;
  const target = i % 5 === 0 ? Math.floor(cols * 0.45) : cols - 4;
  let body = `${cjk} ${emoji} bash exit 0 wrote src/components/file-${i % 97}.ts `;
  while (body.length < target) body += "abcdef ";
  return prefix + body.slice(0, target) + "\r\n";
}

function writeAll(term: Terminal, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Promise((resolve) => {
    const next = () => {
      if (offset >= bytes.length) {
        resolve();
        return;
      }
      const end = Math.min(offset + CHUNK, bytes.length);
      const slice = bytes.subarray(offset, end);
      offset = end;
      term.write(slice, next);
    };
    next();
  });
}

function rendererName(term: Terminal): string {
  const core = (term as unknown as { _core?: { _renderService?: { _renderer?: { constructor?: { name?: string } } } } })._core;
  return core?._renderService?._renderer?.constructor?.name ?? "unknown";
}

function cellSize(term: Terminal): string {
  const cell = (
    term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
    }
  )._core?._renderService?.dimensions?.css?.cell;
  if (!cell || cell.width == null || cell.height == null) return "na";
  return `${cell.width}x${cell.height}`;
}

function painted(container: HTMLElement): boolean {
  const rowHost = container.querySelector(".xterm-rows");
  if (rowHost && rowHost.childElementCount > 0) return true;
  const canvas = container.querySelector("canvas");
  return canvas != null && canvas.width > 0 && canvas.height > 0;
}

async function main() {
  const stack = document.getElementById("stack");
  if (!stack) throw new Error("missing #stack");

  const terms: Terminal[] = [];
  const divs: HTMLElement[] = [];

  for (let i = 0; i < n; i++) {
    const div = document.createElement("div");
    div.className = "term";
    div.style.visibility = i === n - 1 ? "visible" : "hidden";
    stack.appendChild(div);
    divs.push(div);

    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.0,
      letterSpacing: 0,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback,
      convertEol: false,
      cols,
      rows,
    });
    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.open(div);
    term.unicode.activeVersion = "11";
    term.resize(cols, rows);

    if (renderer === "webgl") {
      try {
        const webgl = new WebglAddon();
        const index = i;
        webgl.onContextLoss(() => {
          lostIdx.push(index);
          webgl.dispose();
        });
        term.loadAddon(webgl);
      } catch (err) {
        console.warn("WebGL renderer unavailable; falling back to canvas.", err);
      }
    }

    terms.push(term);
  }

  await document.fonts.ready;
  for (const term of terms) term.resize(cols, rows);

  if (fill > 0) {
    const lines: string[] = [];
    for (let i = 0; i < fill; i++) lines.push(agentLine(i));
    const text = lines.join("");
    for (const term of terms) await writeAll(term, text);
  }

  await twoFrames();

  for (const div of divs) div.style.visibility = "hidden";
  divs[0].style.visibility = "visible";
  await twoFrames();
  const index0Painted = painted(divs[0]);
  const index0Renderer = rendererName(terms[0]);
  const index0Cell = cellSize(terms[0]);

  for (const div of divs) div.style.visibility = "hidden";
  divs[n - 1].style.visibility = "visible";
  await twoFrames();
  const lastCell = cellSize(terms[n - 1]);

  const lostList = lostIdx.length ? lostIdx.join(",") : "-";
  const canvas = divs[0].querySelector("canvas") != null ? 1 : 0;
  document.title =
    `READY lost=${lostIdx.length} lostIdx=${lostList}` +
    ` painted=${index0Painted ? 1 : 0} renderer=${index0Renderer} canvas=${canvas}` +
    ` cell0=${index0Cell} cell=${lastCell}`;
}

main().catch((err) => {
  console.error(err);
  document.title = "READY lost=error lostIdx=- painted=0 renderer=error cell0=na cell=na";
});
