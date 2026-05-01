import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquare, Search } from "lucide-solid";
import { useCommandPalette } from "@/context/command-palette";
import { useDiffPanel } from "@/context/diff-panel";
import { displayLabel } from "@/lib/session-label";
import { iconForFile } from "@/lib/file-icon";
import type { SessionMeta } from "@/components/sessions-list";

const MAX_SESSIONS = 50;
const MAX_FILES = 100;

/** Glob → case-insensitive regex. `*` → `.*`, `?` → `.`, every other regex
 *  meta-char is escaped. Plain text falls through and behaves like a substring
 *  search (regex without anchors). */
function buildMatcher(query: string): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  const escaped = q.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

type FileListResult = { files: string[]; truncated: boolean };

export function CommandPalette(props: {
  projectPath: string | null;
  onSelectSession: (meta: SessionMeta) => void;
}) {
  const palette = useCommandPalette();
  const diffPanel = useDiffPanel();

  const [query, setQuery] = createSignal("");
  const [activeIdx, setActiveIdx] = createSignal(0);

  // Reset state on each open so the palette never inherits a stale query.
  createEffect(
    on(palette.isOpen, (open) => {
      if (open) {
        setQuery("");
        setActiveIdx(0);
      }
    }),
  );

  const [sessions] = createResource(
    () =>
      palette.isOpen() && props.projectPath
        ? { path: props.projectPath, _open: palette.isOpen() }
        : null,
    async ({ path }) => {
      return (await invoke("list_sessions_for_project", {
        projectPath: path,
      })) as SessionMeta[];
    },
  );

  const [files] = createResource(
    () =>
      palette.isOpen() && props.projectPath
        ? { path: props.projectPath, _open: palette.isOpen() }
        : null,
    async ({ path }) => {
      return (await invoke("list_files_recursive", {
        projectPath: path,
      })) as FileListResult;
    },
  );

  const sessionsList = createMemo(() => {
    const list = sessions() ?? [];
    const m = buildMatcher(query());
    if (!m) return list.slice(0, MAX_SESSIONS);
    return list
      .filter((s) => m.test(displayLabel(s)))
      .slice(0, MAX_SESSIONS);
  });

  const filesList = createMemo(() => {
    const list = files()?.files ?? [];
    const m = buildMatcher(query());
    if (!m) return list.slice(0, MAX_FILES);
    return list.filter((p) => m.test(p)).slice(0, MAX_FILES);
  });

  const totalCount = createMemo(
    () => sessionsList().length + filesList().length,
  );

  // Reset highlight whenever the visible result set changes.
  createEffect(
    on(query, () => {
      setActiveIdx(0);
    }),
  );

  function selectAt(idx: number) {
    const ss = sessionsList();
    if (idx < ss.length) {
      const meta = ss[idx];
      if (!meta) return;
      props.onSelectSession(meta);
      palette.close();
      return;
    }
    const fs = filesList();
    const fileIdx = idx - ss.length;
    const rel = fs[fileIdx];
    if (!rel || !props.projectPath) return;
    diffPanel.openFile(props.projectPath, rel);
    palette.close();
  }

  function moveBy(delta: number) {
    const n = totalCount();
    if (n === 0) return;
    setActiveIdx((i) => (i + delta + n) % n);
  }

  // Window-level keydown while the palette is open. Bound here (instead of on
  // the modal panel via onKeyDown) so that nav still works after focus has
  // been pulled out of the input — e.g. by diff-panel/editor focusing itself
  // when a previous selection opened a file. Capture phase so we pre-empt
  // anything xterm.js would try to swallow.
  createEffect(() => {
    if (!palette.isOpen()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        palette.close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        moveBy(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        moveBy(-1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        selectAt(activeIdx());
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  return (
    <Show when={palette.isOpen()}>
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) palette.close();
          }}
        >
          <div class="w-[640px] max-w-[90vw] max-h-[70vh] flex flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl overflow-hidden">
            <SearchInput
              query={query()}
              onQueryChange={setQuery}
              hasProject={!!props.projectPath}
            />
            <div class="flex-1 min-h-0 overflow-y-auto">
              <Show when={!props.projectPath}>
                <Empty message="Open a project first." />
              </Show>
              <Show
                when={
                  props.projectPath &&
                  (sessions.loading || files.loading) &&
                  totalCount() === 0
                }
              >
                <Loading />
              </Show>
              <Show
                when={
                  props.projectPath &&
                  !sessions.loading &&
                  !files.loading &&
                  totalCount() === 0
                }
              >
                <Empty message="No matches." />
              </Show>

              <Show when={sessionsList().length > 0}>
                <SectionHeader label="Sessions" />
                <ul class="pb-1">
                  <For each={sessionsList()}>
                    {(s, i) => (
                      <ResultRow
                        active={i() === activeIdx()}
                        onMouseEnter={() => setActiveIdx(i())}
                        onClick={() => selectAt(i())}
                        icon={
                          <MessageSquare
                            size={14}
                            strokeWidth={2}
                            class="text-neutral-500 shrink-0"
                          />
                        }
                        primary={displayLabel(s)}
                        secondary={null}
                      />
                    )}
                  </For>
                </ul>
              </Show>

              <Show when={filesList().length > 0}>
                <SectionHeader label="Files" />
                <ul class="pb-1">
                  <For each={filesList()}>
                    {(rel, i) => {
                      const lastSlash = rel.lastIndexOf("/");
                      const dir =
                        lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : "";
                      const base =
                        lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
                      const icon = iconForFile(base);
                      // Lazy accessor — sessionsList().length and i() can both
                      // change after the row is created (different query, For
                      // reordering), so capturing into a const would freeze a
                      // stale index and break click/select.
                      const globalIdx = () => sessionsList().length + i();
                      return (
                        <ResultRow
                          active={globalIdx() === activeIdx()}
                          onMouseEnter={() => setActiveIdx(globalIdx())}
                          onClick={() => selectAt(globalIdx())}
                          icon={
                            <icon.Icon
                              size={14}
                              strokeWidth={2}
                              class={`${icon.color} shrink-0`}
                            />
                          }
                          primary={base}
                          secondary={dir || null}
                        />
                      );
                    }}
                  </For>
                </ul>
                <Show when={files()?.truncated}>
                  <div class="px-3 py-1.5 text-[10px] text-neutral-600 italic">
                    File list capped at 5000. Refine your query for more.
                  </div>
                </Show>
              </Show>
            </div>
            <Footer />
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function SearchInput(props: {
  query: string;
  onQueryChange: (s: string) => void;
  hasProject: boolean;
}) {
  let inputRef!: HTMLInputElement;
  const palette = useCommandPalette();

  onMount(() => {
    queueMicrotask(() => inputRef?.focus());
  });

  // Re-grab focus on every open. The mount-time autofocus is not enough: when
  // the previous selection was a file, diffPanel.openFile pulls focus into
  // the editor / preview tab, and on reopen we need to take it back so
  // typing lands in the input (and so window-level keydown can use the input
  // as the active element for things like text input).
  createEffect(
    on(palette.isOpen, (open) => {
      if (open) queueMicrotask(() => inputRef?.focus());
    }),
  );

  return (
    <div class="flex items-center gap-2 px-3 border-b border-neutral-800">
      <Search size={14} strokeWidth={2} class="text-neutral-500 shrink-0" />
      <input
        ref={inputRef}
        type="text"
        class="flex-1 bg-transparent py-3 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none"
        placeholder={
          props.hasProject
            ? "Search sessions and files (glob: * ?)…"
            : "No active project"
        }
        value={props.query}
        onInput={(e) => props.onQueryChange(e.currentTarget.value)}
        disabled={!props.hasProject}
        autocomplete="off"
        spellcheck={false}
      />
    </div>
  );
}

function SectionHeader(props: { label: string }) {
  return (
    <div class="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-neutral-500">
      {props.label}
    </div>
  );
}

function ResultRow(props: {
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  icon: any;
  primary: string;
  secondary: string | null;
}) {
  let ref!: HTMLLIElement;

  createEffect(() => {
    if (props.active) {
      ref?.scrollIntoView({ block: "nearest" });
    }
  });

  return (
    <li
      ref={ref}
      class="px-3 py-1.5 flex items-center gap-2 cursor-pointer text-[13px]"
      classList={{
        "bg-neutral-800": props.active,
      }}
      onMouseEnter={props.onMouseEnter}
      onClick={props.onClick}
    >
      {props.icon}
      <Show when={props.secondary}>
        <span class="text-neutral-500 truncate">{props.secondary}</span>
      </Show>
      <span
        class="truncate"
        classList={{
          "text-neutral-100": props.active,
          "text-neutral-300": !props.active,
        }}
      >
        {props.primary}
      </span>
    </li>
  );
}

function Loading() {
  return <div class="px-3 py-4 text-xs text-neutral-500">Loading…</div>;
}

function Empty(props: { message: string }) {
  return <div class="px-3 py-4 text-xs text-neutral-500">{props.message}</div>;
}

function Footer() {
  return (
    <div class="border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-500 flex items-center gap-3">
      <span>↑↓ navigate</span>
      <span>↵ open</span>
      <span>esc close</span>
      <span class="ml-auto">glob: * ?</span>
    </div>
  );
}
