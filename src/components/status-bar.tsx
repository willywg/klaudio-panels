import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Clock, Settings } from "lucide-solid";
import { useTerminal } from "@/context/terminal";
import { useGit } from "@/context/git";
import {
  modelContextAvailability,
  preTabUsageAvailability,
  rateLimitAvailability,
  useStatusBar,
  type Availability,
  type ProfileRateLimitRecord,
  type UsageSnapshot,
} from "@/context/status-bar";
import { relativeTime } from "@/lib/relative-time";
import {
  contextBarColorClass,
  contextSeverity,
  formatUsagePart,
  isStale,
  modelContextUnavailableTooltip,
  profileDisplayLabel,
  rateLimitUnavailableTooltip,
  shouldShowUsageBars,
  usageAriaLabel,
  usageBarAriaLabel,
  usageBarValue,
} from "@/lib/status-bar-format";
import { StatusBarPopover } from "@/components/status-bar-popover";

type Props = {
  activeProjectPath: string | null;
};

/** Persistent 26px footer. Always mounted (mirrors Titlebar's gating
 *  pattern) — when there's no active project, only the app version and a
 *  settings-gear entry point into the popover's settings view render.
 *  Project-scoped content (model/context, git, usage) only renders once a
 *  project is active. */
export function StatusBar(props: Props) {
  let footerRef: HTMLDivElement | undefined;
  const [footerWidth, setFooterWidth] = createSignal(0);

  onMount(() => {
    if (!footerRef) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setFooterWidth(e.contentRect.width);
    });
    ro.observe(footerRef);
    onCleanup(() => ro.disconnect());
  });

  const [appVersion, setAppVersion] = createSignal("");
  onMount(() => {
    void getVersion()
      .then(setAppVersion)
      .catch((err) => console.warn("status-bar: getVersion failed", err));
  });

  return (
    <footer
      ref={footerRef}
      class="h-[26px] shrink-0 border-t border-neutral-800 bg-neutral-950 flex items-center text-[11px] px-2 gap-2 overflow-hidden"
    >
      <Show
        when={props.activeProjectPath}
        fallback={
          <>
            <span class="text-neutral-600 font-mono truncate">
              {appVersion() ? `v${appVersion()}` : ""}
            </span>
            <div class="flex-1" />
            <HomeSettingsButton />
          </>
        }
      >
        {(projectPath) => (
          <ProjectStatusBar
            projectPath={projectPath()}
            footerWidth={footerWidth()}
          />
        )}
      </Show>
    </footer>
  );
}

function HomeSettingsButton() {
  const [open, setOpen] = createSignal(false);
  let wrapRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;

  return (
    <div ref={wrapRef} class="relative flex items-center h-full">
      <button
        ref={triggerRef}
        type="button"
        class="w-6 h-6 rounded flex items-center justify-center text-neutral-600 hover:text-neutral-200 hover:bg-neutral-900 transition"
        onClick={() => setOpen((v) => !v)}
        aria-label="Status bar settings"
        title="Status bar settings"
        aria-haspopup="dialog"
        aria-expanded={open()}
      >
        <Settings size={12} strokeWidth={1.75} />
      </button>
      <Show when={open()}>
        <StatusBarPopover
          wrapRef={wrapRef}
          triggerRef={triggerRef}
          initialView="settings"
          onClose={() => setOpen(false)}
          activeProfileId={undefined}
          overlayInstalled={false}
          usageAvailability="unavailable"
          snapshot={undefined}
          profileRateLimits={undefined}
        />
      </Show>
    </div>
  );
}

function Divider() {
  return (
    <span class="text-neutral-700 select-none shrink-0" aria-hidden="true">
      ·
    </span>
  );
}

function ProjectStatusBar(props: { projectPath: string; footerWidth: number }) {
  const term = useTerminal();
  const git = useGit();
  const statusBar = useStatusBar();

  const activeTab = createMemo(() =>
    term.store.tabs.find((t) => t.id === term.store.activeTabId),
  );

  const snapshot = createMemo(() =>
    statusBar.tabSnapshot(activeTab()?.id ?? ""),
  );

  // Catch-up pull whenever the active tab changes (or first appears) — the
  // live usage:snapshot event is the primary channel, this just covers
  // "just became active / just created, before the bridge has ticked yet".
  createEffect(
    on(
      () => activeTab()?.id,
      (id) => {
        const tab = activeTab();
        if (!id || !tab || !tab.statusBarOverlayInstalled) return;
        void statusBar.ensureTabStatus(id, tab.profileId);
      },
    ),
  );

  // Resolves *this project's* profile id independent of any tab, so a
  // profile's already-cached rate limits (from some earlier session) can
  // show up the moment the project is opened — before any session is
  // picked or started, not just once a brand-new tab's own bridge has
  // ticked. Model/context stay tab-only: there's no meaningful "cached
  // model" to show before a session exists. Re-runs whenever the project
  // itself changes; a project's profile can never change out from under
  // an already-open project (see project_env.rs), so no need to re-resolve
  // beyond that.
  const [projectProfileId, setProjectProfileId] = createSignal<
    string | undefined
  >();
  const [projectProfileFailed, setProjectProfileFailed] = createSignal(false);

  createEffect(
    on(
      () => props.projectPath,
      (path) => {
        setProjectProfileId(undefined);
        setProjectProfileFailed(false);
        invoke<string>("resolve_profile_id", { projectPath: path })
          .then((id) => {
            setProjectProfileId(id);
            void statusBar.ensureProfileRateLimits(id);
          })
          .catch((err) => {
            console.warn("status-bar: resolve_profile_id failed", err);
            setProjectProfileFailed(true);
          });
      },
    ),
  );

  const prefs = statusBar.prefs;

  const modelAvailability = createMemo<Availability>(() =>
    modelContextAvailability(
      activeTab()?.statusBarOverlayInstalled ?? false,
      snapshot(),
    ),
  );

  // The active tab's own profile takes priority the moment one exists;
  // before that, fall back to the project's own resolved profile so
  // cached account-level usage can appear pre-session.
  const effectiveProfileId = createMemo(
    () => activeTab()?.profileId ?? projectProfileId(),
  );

  const profileRateLimits = createMemo(() =>
    statusBar.profileRateLimitsFor(effectiveProfileId() ?? ""),
  );

  const usageAvailability = createMemo<Availability>(() => {
    const tab = activeTab();
    if (tab) {
      return rateLimitAvailability(
        tab.statusBarOverlayInstalled,
        snapshot(),
        profileRateLimits(),
      );
    }
    return preTabUsageAvailability(projectProfileFailed(), profileRateLimits());
  });

  const gitSummary = createMemo(() =>
    git.summaryFor(activeTab()?.projectPath ?? props.projectPath),
  );

  const showAliasPrefix = createMemo(() => statusBar.knownProfileCount() >= 2);

  const showUsageBars = createMemo(() =>
    shouldShowUsageBars(prefs().usageBars, props.footerWidth),
  );

  const showModelSection = createMemo(
    () => prefs().enabled && prefs().sections.model,
  );
  const showGitSection = createMemo(
    () => prefs().enabled && prefs().sections.git && gitSummary().branch !== null,
  );
  const showUsageSection = createMemo(
    () =>
      prefs().enabled &&
      (prefs().sections.usage5h || prefs().sections.usageWeekly),
  );

  return (
    <>
      <Show when={showModelSection()}>
        <ModelContextSection
          availability={modelAvailability()}
          snapshot={snapshot()}
          stale={
            !!activeTab() &&
            isStale(activeTab()!.status, snapshot()?.observed_at ?? 0)
          }
        />
      </Show>

      <Show when={showGitSection()}>
        <Show when={showModelSection()}>
          <Divider />
        </Show>
        <GitSection
          branch={gitSummary().branch!}
          fileCount={gitSummary().file_count}
        />
      </Show>

      <Show when={showUsageSection()}>
        <Show when={showModelSection() || showGitSection()}>
          <Divider />
        </Show>
        <UsageClusterButton
          activeProfileId={effectiveProfileId()}
          overlayInstalled={activeTab()?.statusBarOverlayInstalled ?? false}
          availability={usageAvailability()}
          profileRateLimits={profileRateLimits()}
          snapshot={snapshot()}
          showAlias={showAliasPrefix()}
          showFiveHour={prefs().sections.usage5h}
          showWeekly={prefs().sections.usageWeekly}
          mode={prefs().showAsRemainingVsUsed}
          aliases={prefs().profileAliases}
          showBars={showUsageBars()}
        />
      </Show>
    </>
  );
}

function ModelContextSection(props: {
  availability: Availability;
  snapshot: UsageSnapshot | undefined;
  stale: boolean;
}) {
  return (
    <Show
      when={props.availability === "available"}
      fallback={
        <Show
          when={props.availability === "waiting"}
          fallback={
            <span
              class="text-neutral-600 shrink-0"
              role="img"
              aria-label={modelContextUnavailableTooltip()}
              title={modelContextUnavailableTooltip()}
            >
              —
            </span>
          }
        >
          <span class="flex items-center gap-1.5 text-neutral-600 shrink-0">
            <span
              class="w-1.5 h-1.5 rounded-full bg-neutral-600 animate-pulse"
              role="img"
              aria-label="waiting for data"
            />
            <span>Model ⋯</span>
          </span>
        </Show>
      }
    >
      <span
        class="flex items-center gap-1.5 shrink-0 font-mono"
        classList={{ "opacity-60": props.stale }}
        title={
          props.stale
            ? `Last updated ${relativeTime(props.snapshot?.observed_at ?? 0)}`
            : undefined
        }
      >
        <Show when={props.stale}>
          <span
            role="img"
            aria-label={`stale, updated ${relativeTime(props.snapshot?.observed_at ?? 0)}`}
          >
            <Clock size={10} strokeWidth={2} />
          </span>
        </Show>
        <span class="text-neutral-300">
          {props.snapshot?.model?.display_name ?? "Model"}
        </span>
        <Show when={props.snapshot?.context}>
          {(ctx) => {
            // Severity/color use the RAW percentage — rounding first could
            // shift a borderline value (e.g. 90.4%) into the wrong bucket.
            const raw = () => ctx().used_percentage ?? 0;
            const pct = () => Math.round(raw());
            const severity = () => contextSeverity(raw());
            return (
              <>
                <span class="text-neutral-500">· Ctx {pct()}%</span>
                <span class="w-6 h-[3px] rounded-full bg-neutral-800 overflow-hidden shrink-0">
                  <span
                    class={`block h-full rounded-full ${contextBarColorClass(raw())}`}
                    style={{ width: `${Math.min(100, Math.max(0, pct()))}%` }}
                  />
                </span>
                <Show when={severity() === "critical"}>
                  <span class="text-rose-400 font-bold leading-none" aria-hidden="true">
                    !
                  </span>
                </Show>
              </>
            );
          }}
        </Show>
      </span>
    </Show>
  );
}

function GitSection(props: { branch: string; fileCount: number }) {
  const dirty = () => props.fileCount > 0;
  return (
    <span class="flex items-center gap-1 text-neutral-400 shrink-0 font-mono">
      <span>{props.branch}</span>
      <Show when={dirty()}>
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400" aria-hidden="true" />
        <span>{props.fileCount}</span>
      </Show>
    </span>
  );
}

function UsageClusterButton(props: {
  activeProfileId: string | undefined;
  overlayInstalled: boolean;
  availability: Availability;
  profileRateLimits: ProfileRateLimitRecord | undefined;
  snapshot: UsageSnapshot | undefined;
  showAlias: boolean;
  showFiveHour: boolean;
  showWeekly: boolean;
  mode: "used" | "remaining";
  aliases: Record<string, string>;
  showBars: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  let wrapRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;

  const alias = createMemo(() =>
    props.showAlias
      ? profileDisplayLabel(props.activeProfileId, props.aliases)
      : undefined,
  );

  const fiveHour = createMemo(() => props.profileRateLimits?.rate_limits.five_hour);
  const weekly = createMemo(() => props.profileRateLimits?.rate_limits.seven_day);

  const label = createMemo(() =>
    usageAriaLabel({
      availability: props.availability,
      alias: alias(),
      fiveHourUsedPercentage:
        props.showFiveHour && fiveHour() ? fiveHour()!.used_percentage : null,
      weeklyUsedPercentage:
        props.showWeekly && weekly() ? weekly()!.used_percentage : null,
      // Bars always render percentage USED (see UsageBar) regardless of
      // the remaining/used preference — when they're on screen, the
      // button's own announced label must agree with what's drawn
      // rather than continuing to honor `props.mode`, or a "remaining"
      // user would see "90%" next to a bar while hearing "10% left".
      mode: props.showBars ? "used" : props.mode,
    }),
  );

  // Two distinct real causes collapse into the single "unavailable" enum
  // value — re-derive which applies from overlayInstalled directly, per
  // the task spec's note that this is safe without re-deriving the enum.
  const tooltip = createMemo(() => rateLimitUnavailableTooltip(props.overlayInstalled));

  return (
    <div ref={wrapRef} class="relative flex items-center h-full">
      <button
        ref={triggerRef}
        type="button"
        class="h-full px-1 flex items-center gap-1 shrink-0 font-mono text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 transition rounded-sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-label={label()}
      >
        <Show when={alias()}>
          <span class="text-neutral-500">{alias()}</span>
        </Show>

        <Show
          when={props.availability === "available"}
          fallback={
            <Show
              when={props.availability === "waiting"}
              fallback={
                <span
                  class="flex items-center gap-1 text-neutral-600"
                  title={tooltip()}
                >
                  <span role="img" aria-label={tooltip()}>
                    ⊘
                  </span>
                  <span>usage n/a</span>
                </span>
              }
            >
              <Show when={alias()}>
                <span class="text-neutral-600">·</span>
              </Show>
              <span
                class="w-1.5 h-1.5 rounded-full bg-neutral-600 animate-pulse"
                role="img"
                aria-label="waiting for data"
              />
            </Show>
          }
        >
          <UsageNumbers
            fiveHour={props.showFiveHour ? fiveHour() : undefined}
            weekly={props.showWeekly ? weekly() : undefined}
            mode={props.mode}
            hasAlias={!!alias()}
            showBars={props.showBars}
          />
        </Show>
      </button>
      <Show when={open()}>
        <StatusBarPopover
          wrapRef={wrapRef}
          triggerRef={triggerRef}
          initialView="profile"
          onClose={() => setOpen(false)}
          activeProfileId={props.activeProfileId}
          overlayInstalled={props.overlayInstalled}
          usageAvailability={props.availability}
          snapshot={props.snapshot}
          profileRateLimits={props.profileRateLimits}
        />
      </Show>
    </div>
  );
}

function UsageNumbers(props: {
  fiveHour: { used_percentage: number; resets_at: number } | null | undefined;
  weekly: { used_percentage: number; resets_at: number } | null | undefined;
  mode: "used" | "remaining";
  hasAlias: boolean;
  showBars: boolean;
}) {
  const hasAny = createMemo(() => !!props.fiveHour || !!props.weekly);

  const parts = createMemo(() => {
    const out: string[] = [];
    if (props.fiveHour) out.push(formatUsagePart("5h", props.fiveHour.used_percentage, props.mode));
    if (props.weekly) out.push(formatUsagePart("Week", props.weekly.used_percentage, props.mode));
    return out;
  });

  return (
    <Show when={hasAny()}>
      <Show when={props.hasAlias}>
        <span class="text-neutral-600">·</span>
      </Show>
      <Show
        when={props.showBars}
        fallback={<span>{parts().join(" · ")}</span>}
      >
        <span class="flex items-center gap-2 shrink-0">
          <Show when={props.fiveHour}>
            {(w) => <UsageBar shortLabel="5h" ariaLabel="5-hour usage" usedPercentage={w().used_percentage} />}
          </Show>
          <Show when={props.weekly}>
            {(w) => <UsageBar shortLabel="Week" ariaLabel="Weekly usage" usedPercentage={w().used_percentage} />}
          </Show>
        </span>
      </Show>
    </Show>
  );
}

/** Compact "label + track + percentage" progress bar for the footer's
 *  usage cluster. Fill width, the visible percentage text, and
 *  aria-valuenow all derive from the same `usageBarValue` — see
 *  status-bar-format.ts. The percentage always reads "X% used" (never a
 *  bare number) since the bar's fill is always percentage-USED
 *  regardless of the remaining/used preference — see the `label` memo
 *  in UsageClusterButton for why the button's own aria-label follows
 *  the same rule. Severity color is deliberately computed from the RAW
 *  (unrounded) percentage, not `pct()` — same reasoning as
 *  ModelContextSection's context bar above: rounding first could shift
 *  a borderline value (e.g. 90.4%) into the wrong color bucket. Reuses
 *  `contextBarColorClass`'s severity palette (the same tokens the
 *  context-window bar above already uses) rather than introducing a new
 *  color scale. */
function UsageBar(props: { shortLabel: string; ariaLabel: string; usedPercentage: number }) {
  const pct = createMemo(() => usageBarValue(props.usedPercentage));
  const ariaLabel = createMemo(() => usageBarAriaLabel(props.ariaLabel, props.usedPercentage));

  return (
    <span class="flex items-center gap-1 shrink-0 font-mono">
      <span class="text-neutral-500">{props.shortLabel}</span>
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct()}
        aria-label={ariaLabel()}
        class="w-9 h-[3px] rounded-full bg-neutral-800 overflow-hidden shrink-0"
      >
        <span
          class={`block h-full rounded-full ${contextBarColorClass(props.usedPercentage)}`}
          style={{ width: `${pct()}%` }}
        />
      </span>
      <span class="tabular-nums">{pct()}% used</span>
    </span>
  );
}
