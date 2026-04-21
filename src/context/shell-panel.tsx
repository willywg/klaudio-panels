import {
  createContext,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";

const HEIGHT_KEY = "shellTerminal.height";
const OPEN_KEY_PREFIX = "shellTerminal.open:";
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
/** Max is computed at read time as 60 % of window.innerHeight — the stored
 *  value is only clamped on the way out. */
function maxHeight(): number {
  if (typeof window === "undefined") return 600;
  return Math.max(MIN_HEIGHT + 40, Math.floor(window.innerHeight * 0.6));
}

function readHeight(): number {
  const raw = localStorage.getItem(HEIGHT_KEY);
  if (!raw) return DEFAULT_HEIGHT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.min(maxHeight(), n));
}

function readOpen(projectPath: string): boolean {
  return localStorage.getItem(OPEN_KEY_PREFIX + projectPath) === "1";
}

function writeOpen(projectPath: string, value: boolean) {
  if (value) {
    localStorage.setItem(OPEN_KEY_PREFIX + projectPath, "1");
  } else {
    localStorage.removeItem(OPEN_KEY_PREFIX + projectPath);
  }
}

function makeShellPanelContext() {
  const [height, setHeight] = createSignal(readHeight());
  // A single flat map signal is enough — reads are keyed by project path
  // and the component reading only this project's bool will re-render on
  // any open/close, which we want (the bar is per-project visible anyway).
  const [openMap, setOpenMap] = createSignal<Record<string, boolean>>({});

  function openedFor(projectPath: string): boolean {
    const cached = openMap()[projectPath];
    if (cached !== undefined) return cached;
    const initial = readOpen(projectPath);
    setOpenMap((m) => ({ ...m, [projectPath]: initial }));
    return initial;
  }

  function setOpen(projectPath: string, value: boolean) {
    writeOpen(projectPath, value);
    setOpenMap((m) => ({ ...m, [projectPath]: value }));
  }

  function toggleFor(projectPath: string) {
    setOpen(projectPath, !openedFor(projectPath));
  }

  function heightPx(): number {
    return height();
  }

  function setHeightPx(n: number, persist: boolean) {
    const clamped = Math.max(MIN_HEIGHT, Math.min(maxHeight(), Math.round(n)));
    setHeight(clamped);
    if (persist) localStorage.setItem(HEIGHT_KEY, String(clamped));
  }

  return {
    openedFor,
    setOpen,
    toggleFor,
    heightPx,
    setHeightPx,
    minHeight: MIN_HEIGHT,
    maxHeight,
  };
}

const Ctx = createContext<ReturnType<typeof makeShellPanelContext>>();

export function ShellPanelProvider(props: ParentProps) {
  const ctx = makeShellPanelContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useShellPanel() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShellPanel outside ShellPanelProvider");
  return v;
}
