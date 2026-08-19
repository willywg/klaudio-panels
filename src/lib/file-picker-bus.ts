import { createSignal } from "solid-js";

/** An unresolved "which of these files did you mean?" question.
 *
 *  A signal bus rather than context (mirrors `image-lightbox-bus`) because the
 *  asker is a terminal link provider buried in a component tree and the
 *  answerer is a single app-root modal; threading a prop between them buys
 *  nothing. Only one question can be open at a time, so one slot is enough. */
export type FilePickRequest = {
  /** The path as it was printed in the terminal, shown as context. */
  rel: string;
  /** Project-relative candidates, best-first. Always length >= 2. */
  candidates: string[];
  resolve: (choice: string | null) => void;
};

const [pending, setPending] = createSignal<FilePickRequest | null>(null);

export { pending as pendingFilePick };

/** Ask the user which candidate to open. Resolves to their choice, or `null`
 *  if they dismissed it.
 *
 *  A second question while one is open cancels the first — the user moved on,
 *  and leaving a promise unresolved would leak the caller's continuation. */
export function askWhichFile(
  rel: string,
  candidates: string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = pending();
    if (previous) previous.resolve(null);
    setPending({ rel, candidates, resolve });
  });
}

export function answerFilePick(choice: string | null): void {
  const req = pending();
  if (!req) return;
  setPending(null);
  req.resolve(choice);
}
