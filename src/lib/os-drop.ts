// Translates a set of absolute file paths + a drop position into a
// payload ready for the drop target. Paths inside the active project
// become `@rel`; paths outside stay absolute. Multiple paths are
// space-joined and the result ends with a trailing space so the cursor
// sits past the insertion, ready for a follow-up message.
//
// Returned payload is `null` when nothing useful can be written
// (empty paths, or caller decides the drop missed a target).

/** Where the payload is being typed. Decides how (and whether) a path
 *  with spaces or shell metacharacters gets quoted. */
export type DropTargetKind = "claude" | "shell";

/** POSIX-safe quoting for a shell prompt: leave boring paths bare, wrap
 *  anything else in single quotes (`'` itself becomes `'\''`). Broader
 *  than the old escape-spaces-only rule, which still handed the shell a
 *  broken word for names like `CAMBIOS (1).docx`. */
function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export function buildDropPayload(
  absPaths: string[],
  projectPath: string,
  kind: DropTargetKind = "claude",
): string | null {
  const trimmed = absPaths.filter((p) => p && p.length > 0);
  if (trimmed.length === 0) return null;
  const base = projectPath.endsWith("/")
    ? projectPath.slice(0, -1)
    : projectPath;
  const tokens = trimmed.map((abs) => {
    if (abs === base) return "@.";
    if (abs.startsWith(base + "/")) return `@${abs.slice(base.length + 1)}`;
    // Outside the project — send the absolute path verbatim. Claude
    // Code accepts absolute paths in @ references too, but they're
    // noisier; keeping the bare absolute path lets the user decide
    // whether to prefix with @ or paste into a tool argument.
    return abs;
  });
  // Claude's prompt is prose, not a command line: a backslash there is a
  // literal character, so `CAMBIOS\ 5\ AGOSTO.docx` names a file that
  // doesn't exist and every subsequent read fails. Only the shell wants
  // quoting. (Trade-off: dropping several space-containing paths into
  // Claude at once is ambiguous — the model still reads it fine, and
  // that beats every single-file drop being broken.)
  const out = kind === "shell" ? tokens.map(shellQuote) : tokens;
  return `${out.join(" ")} `;
}

// Resolves a drop target from the Tauri event's *physical* pixel
// position. Tauri reports physical coords but the DOM works in CSS
// pixels, so divide by devicePixelRatio before hit-testing.
export type DropTarget =
  | { kind: "claude"; ptyId: string }
  | { kind: "shell"; ptyId: string }
  | null;

export function findDropTarget(physical: { x: number; y: number }): DropTarget {
  const dpr = window.devicePixelRatio || 1;
  const x = physical.x / dpr;
  const y = physical.y / dpr;
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element)) return null;
  const host = el.closest<HTMLElement>("[data-pty-id]");
  if (!host) return null;
  const kind = host.dataset.ptyKind;
  const ptyId = host.dataset.ptyId;
  if (!ptyId) return null;
  if (kind === "claude") return { kind: "claude", ptyId };
  if (kind === "shell") return { kind: "shell", ptyId };
  return null;
}
