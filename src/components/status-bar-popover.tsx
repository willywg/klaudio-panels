import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { ArrowLeft, Settings } from "lucide-solid";
import {
  modelContextAvailability,
  rateLimitAvailability,
  useStatusBar,
  type ProfileRateLimitRecord,
  type UsageSnapshot,
} from "@/context/status-bar";
import { relativeTime } from "@/lib/relative-time";
import {
  contextSeverity,
  displayPercentage,
  formatResetTime,
  modelContextUnavailableTooltip,
  profileDisplayLabel,
  profileRowLabel,
  rateLimitUnavailableTooltip,
} from "@/lib/status-bar-format";

type View = "profile" | "settings";

type Props = {
  /** Container that wraps BOTH the trigger button and this popover — used
   *  to tell "click on the trigger" apart from a genuine outside click,
   *  same trick notification-bell.tsx's wrapRef plays. */
  wrapRef: HTMLElement | undefined;
  /** Focus target on Escape-close only — outside-click close must NOT
   *  force focus anywhere (see task spec). */
  triggerRef: HTMLElement | undefined;
  initialView: View;
  onClose: () => void;
  activeProfileId: string | undefined;
  /** Whether pty_open actually installed the overlay for the active tab —
   *  passed through explicitly (not re-derived from `snapshot`, which is
   *  also undefined during the ordinary "waiting" state) so the two
   *  distinct "unavailable" causes stay distinguishable. `false` when
   *  there's no active tab at all (e.g. opened from the home-screen gear). */
  overlayInstalled: boolean;
  snapshot: UsageSnapshot | undefined;
  profileRateLimits: ProfileRateLimitRecord | undefined;
};

export function StatusBarPopover(props: Props) {
  const [view, setView] = createSignal<View>(props.initialView);
  let popoverRef: HTMLDivElement | undefined;

  // Rendered via <Portal> (see below) so the footer's own `overflow-hidden`
  // (needed to keep long branch names/paths from blowing out its fixed
  // 26px height) can never clip this popover — a plain CSS `absolute` +
  // `bottom-full` child, which is what this used to be, is clipped by any
  // `overflow: hidden` ancestor regardless of how far outside that
  // ancestor's own box it's positioned. Portaling to `document.body`
  // means position must be computed in viewport (`fixed`) coordinates from
  // the trigger's own rect instead of relying on CSS anchoring to a
  // `position: relative` wrapper we're no longer a DOM descendant of.
  const [style, setStyle] = createSignal<JSX.CSSProperties>({});

  function reposition() {
    const anchor = props.triggerRef;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setStyle({
      position: "fixed",
      right: `${Math.max(0, window.innerWidth - rect.right)}px`,
      bottom: `${Math.max(0, window.innerHeight - rect.top + 4)}px`,
    });
  }

  onMount(() => {
    reposition();
    window.addEventListener("resize", reposition);

    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (
        target instanceof Node &&
        !props.wrapRef?.contains(target) &&
        !popoverRef?.contains(target)
      ) {
        // Outside click: close without stealing focus from wherever the
        // click landed (e.g. back into the terminal).
        props.onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose();
        props.triggerRef?.focus();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <Portal>
      <div
        ref={popoverRef}
        role="dialog"
        aria-label="Usage status"
        class="z-50 w-[300px] max-h-[420px] rounded-md border border-neutral-800 bg-neutral-900 shadow-xl text-[12px] flex flex-col"
        style={style()}
      >
        <Show
          when={view() === "settings"}
          fallback={
            <ProfileView
              activeProfileId={props.activeProfileId}
              overlayInstalled={props.overlayInstalled}
              snapshot={props.snapshot}
              profileRateLimits={props.profileRateLimits}
              onOpenSettings={() => setView("settings")}
            />
          }
        >
          <SettingsView onBack={() => setView("profile")} />
        </Show>
      </div>
    </Portal>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="px-3 py-1.5 flex items-center justify-between gap-3">
      <span class="text-neutral-500">{props.label}</span>
      <span class="text-neutral-200 text-right">{props.children}</span>
    </div>
  );
}

function Muted(props: { text: string; title?: string }) {
  return (
    <span class="text-neutral-600" title={props.title}>
      {props.text}
    </span>
  );
}

/** Pulsing-dot "waiting for data" treatment, same visual language as the
 *  compact bar's waiting state — used for any popover row whose data
 *  hasn't arrived yet (as opposed to a row that's permanently
 *  unavailable, which uses <Muted> with a cause-specific tooltip). */
function Waiting() {
  return (
    <span class="flex items-center justify-end gap-1.5 text-neutral-600">
      <span
        class="w-1.5 h-1.5 rounded-full bg-neutral-600 animate-pulse"
        role="img"
        aria-label="waiting for data"
      />
      <span>waiting…</span>
    </span>
  );
}

function ProfileView(props: {
  activeProfileId: string | undefined;
  overlayInstalled: boolean;
  snapshot: UsageSnapshot | undefined;
  profileRateLimits: ProfileRateLimitRecord | undefined;
  onOpenSettings: () => void;
}) {
  const statusBar = useStatusBar();
  const prefs = statusBar.prefs;

  // Ticks once a second, ONLY while this popover is mounted — never a
  // global timer. Drives the countdown-mode reset strings.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(t));
  });

  const profileLabel = createMemo(() =>
    props.activeProfileId
      ? profileDisplayLabel(props.activeProfileId, prefs().profileAliases)
      : undefined,
  );

  const modelName = createMemo(() => props.snapshot?.model?.display_name);
  const contextPct = createMemo(() => props.snapshot?.context?.used_percentage);

  const fiveHour = createMemo(() => props.profileRateLimits?.rate_limits.five_hour);
  const weekly = createMemo(() => props.profileRateLimits?.rate_limits.seven_day);

  const lastUpdatedAt = createMemo(() => {
    const a = props.snapshot?.observed_at ?? 0;
    const b = props.profileRateLimits?.observed_at ?? 0;
    return Math.max(a, b);
  });

  // Same availability contract the compact bar uses — "waiting" (no
  // snapshot yet, still ticking) must render differently from a
  // permanent "unavailable" (bridge never ran, or API-key billing), even
  // though both currently lack a value to show.
  const modelContextAvail = createMemo(() =>
    modelContextAvailability(props.overlayInstalled, props.snapshot),
  );
  const rateLimitAvail = createMemo(() =>
    rateLimitAvailability(
      props.overlayInstalled,
      props.snapshot,
      props.profileRateLimits,
    ),
  );

  const unavailableTitle = createMemo(() => modelContextUnavailableTooltip());
  const rateUnavailableTitle = createMemo(() =>
    rateLimitUnavailableTooltip(props.overlayInstalled),
  );

  return (
    <>
      <div class="px-3 py-2 border-b border-neutral-800 flex items-center justify-between gap-2">
        <span class="text-[12px] font-medium text-neutral-100 truncate">
          {profileLabel() ? `${profileLabel()} profile` : "No active profile"}
        </span>
        <button
          type="button"
          class="w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition shrink-0"
          onClick={props.onOpenSettings}
          aria-label="Status bar settings"
          title="Settings"
        >
          <Settings size={13} strokeWidth={1.75} />
        </button>
      </div>

      <Show
        when={props.activeProfileId}
        fallback={
          <div class="px-3 py-8 text-center text-neutral-500">
            No active session
          </div>
        }
      >
        <div class="overflow-y-auto flex-1 py-1">
          <Row label="5-hour window">
            <Show
              when={rateLimitAvail() === "available"}
              fallback={
                <Show
                  when={rateLimitAvail() === "waiting"}
                  fallback={<Muted text="n/a" title={rateUnavailableTitle()} />}
                >
                  <Waiting />
                </Show>
              }
            >
              <Show when={fiveHour()} fallback={<Muted text="n/a" />}>
                {(w) => (
                  <span class="font-mono">
                    {displayPercentage(w().used_percentage, "used")}% used ·{" "}
                    {formatResetTime(w().resets_at, prefs().resetDisplay, now())}
                  </span>
                )}
              </Show>
            </Show>
          </Row>

          <Row label="Weekly window">
            <Show
              when={rateLimitAvail() === "available"}
              fallback={
                <Show
                  when={rateLimitAvail() === "waiting"}
                  fallback={<Muted text="n/a" title={rateUnavailableTitle()} />}
                >
                  <Waiting />
                </Show>
              }
            >
              <Show when={weekly()} fallback={<Muted text="n/a" />}>
                {(w) => (
                  <span class="font-mono">
                    {displayPercentage(w().used_percentage, "used")}% used ·{" "}
                    {formatResetTime(w().resets_at, prefs().resetDisplay, now())}
                  </span>
                )}
              </Show>
            </Show>
          </Row>

          <Row label="Context">
            <Show
              when={modelContextAvail() === "available"}
              fallback={
                <Show
                  when={modelContextAvail() === "waiting"}
                  fallback={<Muted text="n/a" title={unavailableTitle()} />}
                >
                  <Waiting />
                </Show>
              }
            >
              <Show when={contextPct() != null} fallback={<Muted text="n/a" />}>
                <span
                  class="font-mono"
                  classList={{
                    "text-amber-400": contextSeverity(contextPct() ?? 0) === "warning",
                    "text-rose-400": contextSeverity(contextPct() ?? 0) === "critical",
                  }}
                >
                  {Math.round(contextPct() ?? 0)}% used
                </span>
              </Show>
            </Show>
          </Row>

          <Row label="Model">
            <Show
              when={modelContextAvail() === "available"}
              fallback={
                <Show
                  when={modelContextAvail() === "waiting"}
                  fallback={<Muted text="n/a" title={unavailableTitle()} />}
                >
                  <Waiting />
                </Show>
              }
            >
              <Show when={modelName()} fallback={<Muted text="n/a" />}>
                {modelName()}
              </Show>
            </Show>
          </Row>

          <Row label="Last updated">
            <Show
              when={lastUpdatedAt() > 0}
              fallback={<Muted text="—" />}
            >
              {relativeTime(lastUpdatedAt(), now())}
            </Show>
          </Row>
        </div>
      </Show>
    </>
  );
}

function SettingsView(props: { onBack: () => void }) {
  const statusBar = useStatusBar();
  const prefs = statusBar.prefs;

  function toggleSection(key: "model" | "git" | "usage5h" | "usageWeekly") {
    statusBar.updatePrefs({ sections: { [key]: !prefs().sections[key] } });
  }

  return (
    <>
      <div class="px-2 py-2 border-b border-neutral-800 flex items-center gap-1">
        <button
          type="button"
          class="w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition"
          onClick={props.onBack}
          aria-label="Back to profile"
          title="Back"
        >
          <ArrowLeft size={13} strokeWidth={1.75} />
        </button>
        <span class="text-[10px] uppercase tracking-wide text-neutral-500 font-medium">
          Status bar settings
        </span>
      </div>

      <div class="overflow-y-auto flex-1 py-1">
        <ToggleRow
          label="Status bar"
          checked={prefs().enabled}
          onToggle={() => statusBar.updatePrefs({ enabled: !prefs().enabled })}
        />
        <div class="pl-3">
          <ToggleRow
            label="Model + context"
            checked={prefs().sections.model}
            onToggle={() => toggleSection("model")}
            disabled={!prefs().enabled}
          />
          <ToggleRow
            label="Git branch"
            checked={prefs().sections.git}
            onToggle={() => toggleSection("git")}
            disabled={!prefs().enabled}
          />
          <ToggleRow
            label="5-hour usage"
            checked={prefs().sections.usage5h}
            onToggle={() => toggleSection("usage5h")}
            disabled={!prefs().enabled}
          />
          <ToggleRow
            label="Weekly usage"
            checked={prefs().sections.usageWeekly}
            onToggle={() => toggleSection("usageWeekly")}
            disabled={!prefs().enabled}
          />
        </div>

        <div class="border-t border-neutral-800 mt-1 pt-2 px-3">
          <div class="text-[11px] text-neutral-500 mb-1.5">Show usage as</div>
          <RadioPair
            value={prefs().showAsRemainingVsUsed}
            options={[
              { value: "used", label: "Used" },
              { value: "remaining", label: "Remaining" },
            ]}
            onChange={(v) =>
              statusBar.updatePrefs({
                showAsRemainingVsUsed: v as "used" | "remaining",
              })
            }
          />
        </div>

        <div class="pt-2 px-3">
          <div class="text-[11px] text-neutral-500 mb-1.5">Reset time as</div>
          <RadioPair
            value={prefs().resetDisplay}
            options={[
              { value: "countdown", label: "Countdown" },
              { value: "timestamp", label: "Timestamp" },
            ]}
            onChange={(v) =>
              statusBar.updatePrefs({
                resetDisplay: v as "countdown" | "timestamp",
              })
            }
          />
        </div>

        <div class="border-t border-neutral-800 mt-2 pt-2">
          <ToggleRow
            label="Usage data"
            help={prefs().usageIntegrationEnabled ? "Connected" : "Not connected"}
            checked={prefs().usageIntegrationEnabled}
            onToggle={() =>
              statusBar.updatePrefs({
                usageIntegrationEnabled: !prefs().usageIntegrationEnabled,
              })
            }
          />
        </div>

        <div class="border-t border-neutral-800 mt-2 pt-2 px-3 pb-2">
          <div class="text-[10px] uppercase tracking-wide text-neutral-500 font-medium mb-1.5">
            Profiles
          </div>
          <For each={statusBar.knownProfileIds()}>
            {(id) => <ProfileAliasRow profileId={id} />}
          </For>
        </div>
      </div>
    </>
  );
}

function ProfileAliasRow(props: { profileId: string }) {
  const statusBar = useStatusBar();
  const prefs = statusBar.prefs;
  const label = createMemo(() => profileRowLabel(props.profileId, prefs().profileAliases));

  function onChange(e: Event) {
    const value = (e.currentTarget as HTMLInputElement).value;
    statusBar.updatePrefs({
      profileAliases: { ...prefs().profileAliases, [props.profileId]: value },
    });
  }

  return (
    <div class="flex items-center gap-2 py-1">
      <Show when={label()}>
        <span class="text-[11px] text-neutral-400 w-16 shrink-0 truncate">
          {label()}
        </span>
      </Show>
      <input
        type="text"
        class="flex-1 min-w-0 h-6 px-1.5 rounded border border-neutral-800 bg-neutral-950 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
        value={prefs().profileAliases[props.profileId] ?? ""}
        placeholder="Unnamed profile"
        onChange={onChange}
      />
    </div>
  );
}

function RadioPair(props: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div class="flex items-center gap-1" role="radiogroup">
      <For each={props.options}>
        {(opt) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === opt.value}
            onClick={() => props.onChange(opt.value)}
            class="px-2 py-1 rounded text-[11px] transition"
            classList={{
              "bg-neutral-800 text-neutral-100": props.value === opt.value,
              "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/50":
                props.value !== opt.value,
            }}
          >
            {opt.label}
          </button>
        )}
      </For>
    </div>
  );
}

function ToggleRow(props: {
  label: string;
  help?: JSX.Element;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      class="px-3 py-2 flex items-start justify-between gap-3"
      classList={{ "opacity-60": props.disabled }}
    >
      <div class="flex-1 min-w-0">
        <div class="text-[12px] text-neutral-100 font-medium">{props.label}</div>
        <Show when={props.help}>
          <div class="text-[11px] text-neutral-400 mt-0.5">{props.help}</div>
        </Show>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-disabled={props.disabled || undefined}
        aria-label={props.label}
        onClick={() => {
          if (props.disabled) return;
          props.onToggle();
        }}
        disabled={props.disabled}
        class="shrink-0 mt-0.5 w-9 h-5 rounded-full transition relative"
        classList={{
          "bg-emerald-500/80": props.checked && !props.disabled,
          "bg-neutral-700": !props.checked || props.disabled,
          "cursor-not-allowed": props.disabled,
        }}
      >
        <span
          class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all"
          classList={{
            "left-[18px]": props.checked,
            "left-0.5": !props.checked,
          }}
        />
      </button>
    </div>
  );
}
