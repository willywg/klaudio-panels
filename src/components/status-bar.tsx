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
import { Clock, Settings } from "lucide-solid";
import { useTerminal } from "@/context/terminal";
import { useGit } from "@/context/git";
import {
  modelContextAvailability,
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
  narrowLevelForWidth,
  profileDisplayLabel,
  rateLimitUnavailableTooltip,
  usageAriaLabel,
  visibilityForLevel,
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

  const prefs = statusBar.prefs;

  const modelAvailability = createMemo<Availability>(() =>
    modelContextAvailability(
      activeTab()?.statusBarOverlayInstalled ?? false,
      snapshot(),
    ),
  );

  const usageAvailability = createMemo<Availability>(() =>
    rateLimitAvailability(
      activeTab()?.statusBarOverlayInstalled ?? false,
      snapshot(),
    ),
  );

  const gitSummary = createMemo(() =>
    git.summaryFor(activeTab()?.projectPath ?? props.projectPath),
  );

  const profileRateLimits = createMemo(() =>
    statusBar.profileRateLimitsFor(activeTab()?.profileId ?? ""),
  );

  const showAliasPrefix = createMemo(() => statusBar.knownProfileCount() >= 2);

  const visibility = createMemo(() =>
    visibilityForLevel(narrowLevelForWidth(props.footerWidth)),
  );

  const showModelSection = createMemo(
    () => prefs().enabled && prefs().sections.model,
  );
  const showGitSection = createMemo(
    () =>
      prefs().enabled &&
      prefs().sections.git &&
      visibility().git &&
      gitSummary().branch !== null,
  );
  const showUsageSection = createMemo(
    () =>
      prefs().enabled &&
      (prefs().sections.usage5h || prefs().sections.usageWeekly) &&
      visibility().usageCluster,
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
          activeProfileId={activeTab()?.profileId}
          overlayInstalled={activeTab()?.statusBarOverlayInstalled ?? false}
          availability={usageAvailability()}
          profileRateLimits={profileRateLimits()}
          snapshot={snapshot()}
          showAlias={showAliasPrefix() && visibility().alias}
          showFiveHour={prefs().sections.usage5h && visibility().fiveHour}
          showWeekly={prefs().sections.usageWeekly && visibility().weekly}
          mode={prefs().showAsRemainingVsUsed}
          aliases={prefs().profileAliases}
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
      mode: props.mode,
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
}) {
  const parts = createMemo(() => {
    const out: string[] = [];
    if (props.fiveHour) out.push(formatUsagePart("5h", props.fiveHour.used_percentage, props.mode));
    if (props.weekly) out.push(formatUsagePart("Week", props.weekly.used_percentage, props.mode));
    return out;
  });

  return (
    <Show when={parts().length > 0}>
      <Show when={props.hasAlias}>
        <span class="text-neutral-600">·</span>
      </Show>
      <span>{parts().join(" · ")}</span>
    </Show>
  );
}
