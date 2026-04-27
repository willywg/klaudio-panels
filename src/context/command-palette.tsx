import {
  createContext,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";

function makeCommandPaletteContext() {
  const [isOpen, setOpen] = createSignal(false);

  function open() {
    setOpen(true);
  }
  function close() {
    setOpen(false);
  }
  function toggle() {
    setOpen((v) => !v);
  }

  return { isOpen, open, close, toggle };
}

const Ctx = createContext<ReturnType<typeof makeCommandPaletteContext>>();

export function CommandPaletteProvider(props: ParentProps) {
  const ctx = makeCommandPaletteContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useCommandPalette() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCommandPalette outside CommandPaletteProvider");
  return v;
}
