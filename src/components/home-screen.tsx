import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Search } from "lucide-solid";
import {
  projectColor,
  projectInitial,
  projectLabel,
  relativeTime,
} from "@/lib/recent-projects";
import { useProjects } from "@/context/projects";

type Props = {
  onPick: (path: string) => void;
};

export function HomeScreen(props: Props) {
  const projects = useProjects();
  const [query, setQuery] = createSignal("");
  let searchInput: HTMLInputElement | undefined;

  const sortedByRecency = createMemo(() =>
    [...projects.list].sort((a, b) => b.lastOpened - a.lastOpened),
  );

  // Substring filter over name, full path, and avatar initials — typing the
  // two letters shown on a sidebar tile ("CD") finds that project too.
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return sortedByRecency();
    return sortedByRecency().filter(
      (p) =>
        projectLabel(p.path).toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        projectInitial(p.path, p.customInitials).toLowerCase().includes(q),
    );
  });

  // HomeScreen mounts fresh every time the user lands on home (it lives
  // inside a <Show>), so focusing here puts the cursor in the filter box
  // on every visit without a global shortcut.
  onMount(() => searchInput?.focus());

  async function handleOpen() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") props.onPick(picked);
  }

  return (
    <div class="h-full flex flex-col items-center px-6 py-10 overflow-y-auto preview-scroll">
      {/* my-auto (not justify-center on the parent): margin-auto centering
          collapses to 0 when the column is taller than the viewport, so the
          list scrolls from its first row instead of clipping at the top. */}
      <div class="w-full max-w-2xl my-auto">
        <div class="text-center mb-10">
          <h1 class="text-4xl font-semibold tracking-tight text-neutral-300 mb-3">
            Klaudio Panels
          </h1>
          <div class="flex items-center justify-center gap-2 text-xs text-neutral-500">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
            <span>Ready</span>
          </div>
        </div>

        <div class="flex items-center justify-between mb-3 px-1">
          <h2 class="text-sm text-neutral-300">Recent projects</h2>
          <button
            class="text-xs px-3 py-1.5 border border-neutral-700 rounded hover:bg-neutral-900 hover:border-neutral-600 text-neutral-200 transition flex items-center gap-2"
            onClick={handleOpen}
          >
            <FolderOpen size={14} strokeWidth={2} />
            <span>Open project</span>
          </button>
        </div>

        <Show when={sortedByRecency().length > 0}>
          <div class="relative mb-3">
            <Search
              size={14}
              strokeWidth={2}
              class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
            />
            <input
              ref={searchInput}
              type="text"
              value={query()}
              placeholder="Filter projects…"
              spellcheck={false}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const first = filtered()[0];
                  if (first) props.onPick(first.path);
                } else if (e.key === "Escape" && query()) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              class="w-full pl-9 pr-3 py-2 text-sm bg-neutral-900/60 border border-neutral-800 rounded-lg text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-600 transition"
            />
          </div>
        </Show>

        <div class="border border-neutral-800 rounded-lg overflow-hidden">
          <Show
            when={sortedByRecency().length > 0}
            fallback={
              <div class="px-4 py-8 text-center text-sm text-neutral-500">
                You haven't opened any project yet.
                <br />
                Click <strong class="text-neutral-300">Open project</strong> to get started.
              </div>
            }
          >
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="px-4 py-8 text-center text-sm text-neutral-500">
                  No projects match "{query().trim()}".
                </div>
              }
            >
              <For each={filtered()}>
                {(p, i) => {
                  const initial = () => projectInitial(p.path, p.customInitials);
                  return (
                    <button
                      onClick={() => props.onPick(p.path)}
                      class={
                        "w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-neutral-900/60 transition " +
                        (i() === 0 ? "" : "border-t border-neutral-800/60")
                      }
                    >
                      <span
                        class={
                          "w-8 h-8 rounded-lg shrink-0 flex items-center justify-center font-semibold text-white select-none shadow-sm " +
                          (initial().length >= 3 ? "text-[9px]" : "text-[11px]")
                        }
                        style={{ "background-color": projectColor(p.path) }}
                      >
                        {initial()}
                      </span>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-neutral-200 truncate font-mono">
                          {abbreviateHome(p.path)}
                        </div>
                        <div class="text-[11px] text-neutral-500 truncate mt-0.5">
                          {projectLabel(p.path)}
                        </div>
                      </div>
                      <div class="text-[11px] text-neutral-500 shrink-0 ml-1">
                        {relativeTime(p.lastOpened)}
                      </div>
                    </button>
                  );
                }}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

function abbreviateHome(path: string): string {
  // Infer $HOME from any known project path (first segment "/Users/<name>").
  const m = path.match(/^(\/Users\/[^/]+)/);
  if (m) return "~" + path.slice(m[1].length);
  return path;
}
