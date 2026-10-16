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

const isMac =
  typeof navigator !== "undefined" &&
  navigator.platform.toUpperCase().includes("MAC");

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Safe quoting for a shell prompt: leave boring paths bare, wrap
 *  anything else in quotes. Adapts for POSIX shell (macOS/Linux) and
 *  PowerShell (Windows). */
function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  if (!isMac) {
    return `"${token.replace(/"/g, '`"')}"`;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export function buildDropPayload(
  absPaths: string[],
  projectPath: string,
  kind: DropTargetKind = "claude",
): string | null {
  const trimmed = absPaths.filter((p) => p && p.length > 0);
  if (trimmed.length === 0) return null;
  const normBase = norm(projectPath).replace(/\/+$/, "");
  const baseLower = normBase.toLowerCase();

  const tokens = trimmed.map((rawAbs) => {
    const normAbs = norm(rawAbs);
    const absLower = normAbs.toLowerCase();
    if (absLower === baseLower) return "@.";
    if (absLower.startsWith(baseLower + "/")) {
      const rel = normAbs.slice(normBase.length + 1);
      return `@${rel}`;
    }
    // Outside the project — send the path verbatim. Claude
    // Code accepts absolute paths in @ references too.
    return rawAbs;
  });

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
