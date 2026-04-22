// Translates a set of absolute file paths + a drop position into a
// payload ready for Claude Code's prompt. Paths inside the active
// project become `@rel`; paths outside stay absolute. Multiple paths
// are space-joined and the result ends with a trailing space so the
// cursor sits past the insertion, ready for a follow-up message.
//
// Returned payload is `null` when nothing useful can be written
// (empty paths, or caller decides the drop missed a target).

export function buildDropPayload(
  absPaths: string[],
  projectPath: string,
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
  // Escape spaces with a backslash so shells / Claude's prompt parser
  // treat each multi-word path as a single token.
  const escaped = tokens.map((t) => t.replace(/ /g, "\\ "));
  return `${escaped.join(" ")} `;
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
