/** Terminal-only editors we embed in a secondary PTY instead of routing
 *  through `open -a`. The `binary` is resolved against the hydrated
 *  login-shell PATH (see `which_in_shell` in src-tauri/src/shell_env.rs).
 *
 *  `argv` receives the absolute file path appended at the end. No template
 *  substitution — we keep it dumb. */
export type TerminalEditor = {
  id: string;
  label: string;
  binary: string;
  /** Extra args prepended before the file path (usually empty). */
  args: string[];
};

export const TERMINAL_EDITORS: readonly TerminalEditor[] = [
  { id: "nvim",  label: "Neovim",   binary: "nvim",  args: [] },
  { id: "vim",   label: "Vim",      binary: "vim",   args: [] },
  { id: "helix", label: "Helix",    binary: "hx",    args: [] },
  { id: "micro", label: "Micro",    binary: "micro", args: [] },
] as const;

export function findTerminalEditor(id: string): TerminalEditor | undefined {
  return TERMINAL_EDITORS.find((e) => e.id === id);
}
