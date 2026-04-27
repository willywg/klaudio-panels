import {
  createContext,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";

/** Cross-pane "reveal a file in the file tree" bus.
 *
 *  diffPanel.openFile (whether triggered from the Cmd+K palette, the file
 *  tree itself, or future surfaces) calls `request(projectPath, rel)` with
 *  the just-opened file. The FileTree component reacts via createEffect:
 *  expand the chain of ancestor directories, scroll the row into view,
 *  flash a transient highlight.
 *
 *  Each request gets a fresh monotonic `id`. The consumer tracks
 *  `lastHandledId` and only acts on a higher one — that prevents the
 *  handler self-triggering when it mutates other state and re-runs the
 *  effect on the same pending payload.
 */
export type RevealRequest = {
  projectPath: string;
  rel: string;
  id: number;
};

function makeRevealContext() {
  let nextId = 1;
  const [pending, setPending] = createSignal<RevealRequest | null>(null);

  function request(projectPath: string, rel: string) {
    setPending({ projectPath, rel, id: nextId++ });
  }

  return { pending, request };
}

const Ctx = createContext<ReturnType<typeof makeRevealContext>>();

export function RevealProvider(props: ParentProps) {
  const ctx = makeRevealContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useReveal() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useReveal outside RevealProvider");
  return v;
}
