/** Tiny pub-sub for "which file is selected in the project's <FileTree>".
 *  Pulled out as a bus (mirrors `terminal-focus-bus`) so the global ⌘E
 *  handler in `App.tsx` can consult tree selection without forcing a
 *  context plumb-through. Only one <FileTree> is mounted at a time (the
 *  sidebar conditionally renders it), so a single global slot is enough.
 *
 *  The slot is cleared automatically on FileTree unmount; consumers must
 *  also gate on `projectPath === activeProjectPath` to avoid acting on a
 *  stale selection from a different project. */

export type SelectedFile = {
  projectPath: string;
  /** Relative path inside the project (no leading slash). */
  rel: string;
  isDir: boolean;
};

let current: SelectedFile | null = null;

export function setSelectedFile(value: SelectedFile | null): void {
  current = value;
}

export function selectedFile(): SelectedFile | null {
  return current;
}
