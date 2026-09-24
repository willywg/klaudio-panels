import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { useAgents, type AgentInfo } from "@/context/agents";
import { AGENT_DISPLAY, CURSOR, type AgentId } from "@/lib/agents";

type HookStatus =
  | { state: "on" }
  | { state: "off" }
  | { state: "unmanaged"; reason: string; snippet: string };

type Draft = { enabled: boolean; binaryPath: string };

/** Discovery's answer for one agent, shown as the placeholder of an empty
 *  path field: "leave this blank and this is what runs". */
type Discovered =
  | { state: "searching" }
  | { state: "found"; path: string }
  | { state: "missing"; message: string };

/** The app's first settings surface: per agent, whether it is offered at
 *  all and which binary runs. Both are stored by the backend
 *  (`agent_settings.rs`) because they gate process spawning, and both are
 *  validated there — this dialog only drafts them and shows what came back.
 *
 *  Changes apply on Save, not per keystroke: a path is checked by running
 *  it, and running every partial path as it is typed would be both slow and
 *  a strange thing to do to someone's machine. */
export function AgentSettingsDialog(props: { open: boolean; onClose: () => void }) {
  const agents = useAgents();
  const [draft, setDraft] = createStore<Record<string, Draft>>({});
  const [discovered, setDiscovered] = createStore<Record<string, Discovered>>({});
  const [errors, setErrors] = createStore<Record<string, string | null>>({});
  const [saving, setSaving] = createSignal(false);
  const [hook, setHook] = createSignal<HookStatus | null>(null);
  const [hookError, setHookError] = createSignal<string | null>(null);
  const [hookBusy, setHookBusy] = createSignal(false);
  let panelRef: HTMLDivElement | undefined;

  function reset(list: AgentInfo[]) {
    for (const a of list) {
      setDraft(a.id, { enabled: a.enabled, binaryPath: a.binaryPath ?? "" });
      setErrors(a.id, null);
    }
  }

  async function discover(id: AgentId) {
    setDiscovered(id, { state: "searching" });
    try {
      const path = await invoke<string>("discover_agent_binary", { agentId: id });
      setDiscovered(id, { state: "found", path });
    } catch (err) {
      setDiscovered(id, { state: "missing", message: String(err) });
    }
  }

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        void agents.refresh().then(() => {
          reset(agents.agents());
          for (const a of agents.agents()) void discover(a.id);
          void refreshHook();
        });
      },
    ),
  );

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (props.open && e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const enabledInDraft = () =>
    agents.agents().filter((a) => draft[a.id]?.enabled).length;

  /** The last enabled agent's switch is locked rather than refused on save:
   *  an app with no agent can start nothing, and the backend refuses it
   *  anyway (`set_agent_settings`). */
  const isLastEnabled = (id: AgentId) =>
    draft[id]?.enabled === true && enabledInDraft() === 1;

  function changed(a: AgentInfo): boolean {
    const d = draft[a.id];
    if (!d) return false;
    return d.enabled !== a.enabled || d.binaryPath.trim() !== (a.binaryPath ?? "");
  }

  async function refreshHook() {
    try {
      setHook(await invoke<HookStatus>("cursor_hook_status"));
    } catch (err) {
      setHook({ state: "unmanaged", reason: String(err), snippet: "" });
    }
  }

  async function toggleHook() {
    const current = hook();
    if (!current || current.state === "unmanaged") return;
    setHookBusy(true);
    setHookError(null);
    try {
      await invoke(
        current.state === "on" ? "cursor_hook_uninstall" : "cursor_hook_install",
      );
      await refreshHook();
    } catch (err) {
      setHookError(String(err));
    } finally {
      setHookBusy(false);
    }
  }

  async function save() {
    setSaving(true);
    let failed = false;
    // Enables before disables, so a swap (turn one on, the other off) never
    // passes through a state with nothing enabled that the backend refuses.
    const order = [...agents.agents()].sort(
      (a, b) => Number(draft[b.id]?.enabled) - Number(draft[a.id]?.enabled),
    );
    for (const a of order) {
      if (!changed(a)) continue;
      const d = draft[a.id];
      try {
        // eslint-disable-next-line no-await-in-loop
        await agents.save(a.id, {
          enabled: d.enabled,
          binaryPath: d.binaryPath.trim() || null,
        });
        setErrors(a.id, null);
      } catch (err) {
        setErrors(a.id, String(err));
        failed = true;
      }
    }
    setSaving(false);
    if (!failed) props.onClose();
  }

  function onBackdropClick(e: MouseEvent) {
    if (panelRef && e.target instanceof Node && panelRef.contains(e.target)) return;
    props.onClose();
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm"
        onClick={onBackdropClick}
      >
        <div
          ref={panelRef}
          class="w-[520px] max-w-[calc(100vw-32px)] rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl p-4 text-[12.5px] text-neutral-200"
        >
          <div class="font-semibold text-[13px] text-neutral-100">Agents</div>
          <div class="text-neutral-400 mt-1 mb-4 leading-snug">
            Which coding agents Klaudio offers, and which binary runs for each.
            Leave the path empty to use the one Klaudio finds.
          </div>

          <div class="flex flex-col gap-3">
            <For each={agents.agents()}>
              {(a) => {
                const d = () => draft[a.id];
                const disc = () => discovered[a.id];
                const placeholder = () => {
                  const x = disc();
                  if (!x || x.state === "searching") return "Searching…";
                  if (x.state === "found") return x.path;
                  return `${a.binName} not found — enter a path`;
                };
                return (
                  <div class="rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
                    <div class="flex items-center gap-2">
                      <span class="font-medium text-neutral-100 flex-1">
                        {AGENT_DISPLAY[a.id].name}
                      </span>
                      <label
                        class={
                          "flex items-center gap-2 text-[12px] select-none " +
                          (isLastEnabled(a.id)
                            ? "text-neutral-500 cursor-not-allowed"
                            : "text-neutral-300 cursor-pointer")
                        }
                        title={
                          isLastEnabled(a.id)
                            ? "At least one agent has to stay enabled"
                            : undefined
                        }
                      >
                        Enabled
                        <input
                          type="checkbox"
                          class="accent-indigo-500"
                          checked={d()?.enabled ?? false}
                          disabled={isLastEnabled(a.id) || saving()}
                          onChange={(e) =>
                            setDraft(a.id, "enabled", e.currentTarget.checked)
                          }
                        />
                      </label>
                    </div>

                    <label class="block mt-2.5 text-[11px] text-neutral-500">
                      Binary path
                    </label>
                    <input
                      type="text"
                      spellcheck={false}
                      autocomplete="off"
                      class="mt-1 w-full h-7 px-2 rounded bg-neutral-900 border border-neutral-700 focus:border-indigo-500/70 outline-none font-mono text-[11.5px] text-neutral-200 placeholder:text-neutral-600"
                      placeholder={placeholder()}
                      value={d()?.binaryPath ?? ""}
                      disabled={saving()}
                      onInput={(e) =>
                        setDraft(a.id, "binaryPath", e.currentTarget.value)
                      }
                    />
                    <Show when={disc()?.state === "missing" && !d()?.binaryPath.trim()}>
                      <div class="mt-1.5 text-[11px] text-amber-400/90 leading-snug">
                        {(disc() as { message: string }).message}
                      </div>
                    </Show>
                    <Show when={errors[a.id]}>
                      <div class="mt-1.5 text-[11px] text-red-400 leading-snug break-words">
                        {errors[a.id]}
                      </div>
                    </Show>
                    <Show when={a.id === CURSOR}>
                      <CursorHookToggle
                        status={hook()}
                        error={hookError()}
                        busy={hookBusy()}
                        onToggle={() => void toggleHook()}
                      />
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>

          <div class="mt-3 text-[11px] text-neutral-500 leading-snug">
            Disabling an agent hides it without deleting anything: its sessions
            and remembered tabs come back when it is enabled again. Tabs already
            open keep running.
          </div>

          <div class="flex gap-2 justify-end mt-4">
            <button
              type="button"
              class="px-3 h-7 rounded text-[12px] transition border border-neutral-700 hover:bg-neutral-800 text-neutral-200"
              onClick={() => props.onClose()}
            >
              Cancel
            </button>
            <button
              type="button"
              class="px-3 h-7 rounded text-[12px] transition border border-indigo-500/40 hover:border-indigo-400/70 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-200 disabled:opacity-50"
              disabled={saving()}
              onClick={() => void save()}
            >
              {saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

function CursorHookToggle(props: {
  status: HookStatus | null;
  error: string | null;
  busy: boolean;
  onToggle: () => void;
}) {
  const status = () => props.status;
  const on = () => status()?.state === "on";
  const unmanaged = () => status()?.state === "unmanaged";
  const label = () => {
    const s = status();
    if (!s) return "Checking hooks.json…";
    if (s.state === "on") return "On";
    if (s.state === "off") return "Off";
    return "Can't manage (edited by hand)";
  };

  return (
    <div class="mt-3 pt-3 border-t border-neutral-800">
      <label
        class={
          "flex items-start gap-2 text-[12px] select-none " +
          (unmanaged() ? "text-neutral-500 cursor-not-allowed" : "text-neutral-300 cursor-pointer")
        }
      >
        <input
          type="checkbox"
          class="accent-indigo-500 mt-0.5"
          checked={on()}
          disabled={props.busy || unmanaged() || !status()}
          onChange={() => props.onToggle()}
        />
        <span>
          <span class="text-neutral-200">Turn notifications</span>
          <span class="text-neutral-500"> — adds a hook to ~/.cursor/hooks.json</span>
          <span class="block text-[11px] text-neutral-500 mt-0.5">
            {label()}. Turning Cursor off does not remove this hook. The script
            does nothing outside Klaudio.
          </span>
        </span>
      </label>
      <Show when={unmanaged() && status()?.state === "unmanaged"}>
        <div class="mt-1.5 text-[11px] text-amber-400/90 leading-snug whitespace-pre-wrap break-words">
          {(status() as { reason: string; snippet: string }).reason}
          <Show when={(status() as { snippet: string }).snippet}>
            <pre class="mt-1 p-2 rounded bg-neutral-900 border border-neutral-800 text-neutral-300 overflow-x-auto">
              {(status() as { snippet: string }).snippet}
            </pre>
          </Show>
        </div>
      </Show>
      <Show when={props.error}>
        <div class="mt-1.5 text-[11px] text-red-400 leading-snug whitespace-pre-wrap break-words">
          {props.error}
        </div>
      </Show>
    </div>
  );
}
