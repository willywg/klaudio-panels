import { open } from "@tauri-apps/plugin-dialog";

export function ProjectPicker(props: { onPick: (path: string) => void }) {
  async function choose() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") props.onPick(picked);
  }

  return (
    <div class="flex-1 flex items-center justify-center">
      <div class="text-center max-w-md">
        <h1 class="text-2xl font-semibold mb-2">Claude Code UI</h1>
        <p class="text-neutral-400 mb-6 text-sm">
          Elige una carpeta de proyecto. La app listará tus sesiones previas de
          Claude Code (si existen en <code>~/.claude/projects</code>) y te
          permitirá continuar o iniciar una nueva.
        </p>
        <button
          class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-md text-sm font-medium"
          onClick={choose}
        >
          Abrir proyecto…
        </button>
      </div>
    </div>
  );
}
