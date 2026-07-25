// Pure, framework-free helpers backing the status-bar footer + popover
// (components/status-bar.tsx, components/status-bar-popover.tsx). Kept
// import-free of any @/context module — mirrors the rest of lib/ (e.g.
// lib/session-label.ts's local SessionLike) so these stay independently
// testable and don't couple the lib layer to Solid context internals. The
// `Availability` union below is structurally identical to (and interops
// freely with) context/status-bar's own exported type.

export type Availability = "waiting" | "available" | "unavailable";

// ---------------------------------------------------------------------
// Responsive narrowing. The footer drops sections in a fixed order as its
// own measured width shrinks — see status-bar.tsx's ResizeObserver. Levels
// are coarse steps (not a continuous function) so the UI doesn't flicker
// section visibility on sub-pixel width changes.
// ---------------------------------------------------------------------

export type NarrowLevel = 0 | 1 | 2 | 3 | 4;

/** Level 0 = full width, nothing dropped. Level 4 = floor — only the
 *  model+context anchor (section 1) remains; everything else (git widget,
 *  usage cluster including its alias) is gone. Breakpoints are tuned for
 *  this footer's actual content, not a generic grid. */
export function narrowLevelForWidth(width: number): NarrowLevel {
  if (width >= 560) return 0;
  if (width >= 460) return 1;
  if (width >= 380) return 2;
  if (width >= 300) return 3;
  return 4;
}

export type StatusBarNarrowVisibility = {
  /** Weekly usage number — first to go. */
  weekly: boolean;
  /** 5-hour usage number — second to go. */
  fiveHour: boolean;
  /** Git branch widget — third to go. */
  git: boolean;
  /** Profile alias prefix on the usage cluster — fourth to go. */
  alias: boolean;
  /** Whether the usage-cluster button renders at all. Once alias, 5h, and
   *  weekly are all gone there is nothing left to show or click, so the
   *  whole button disappears rather than rendering an empty shell. */
  usageCluster: boolean;
};

export function visibilityForLevel(
  level: NarrowLevel,
): StatusBarNarrowVisibility {
  return {
    weekly: level < 1,
    fiveHour: level < 2,
    git: level < 3,
    alias: level < 4,
    usageCluster: level < 4,
  };
}

// ---------------------------------------------------------------------
// Context-usage severity. Drives the mini progress-bar fill color AND a
// non-color "!" glyph above 90% — the glyph exists so the highest-severity
// state is never signalled by hue alone (colorblind-safe, matches the
// border/ring treatment notification-toast.tsx already uses for its
// permission-request state).
// ---------------------------------------------------------------------

export type ContextSeverity = "normal" | "warning" | "critical";

export function contextSeverity(usedPercentage: number): ContextSeverity {
  if (usedPercentage > 90) return "critical";
  if (usedPercentage >= 70) return "warning";
  return "normal";
}

export function contextBarColorClass(usedPercentage: number): string {
  switch (contextSeverity(usedPercentage)) {
    case "critical":
      return "bg-rose-400";
    case "warning":
      return "bg-amber-400";
    default:
      return "bg-neutral-500";
  }
}

// ---------------------------------------------------------------------
// Used vs. remaining display.
// ---------------------------------------------------------------------

export type UsageDisplayMode = "used" | "remaining";

/** Rounds `usedPercentage` (or its complement) to the nearest integer for
 *  display, per the user's showAsRemainingVsUsed preference. */
export function displayPercentage(
  usedPercentage: number,
  mode: UsageDisplayMode,
): number {
  return Math.round(mode === "remaining" ? 100 - usedPercentage : usedPercentage);
}

/** Formats one usage window's compact label, e.g. "5h 31%" (used mode) or
 *  "5h 69% left" (remaining mode). `label` is the short window name
 *  ("5h", "Week", ...) — caller decides wording. */
export function formatUsagePart(
  label: string,
  usedPercentage: number,
  mode: UsageDisplayMode,
): string {
  const pct = displayPercentage(usedPercentage, mode);
  return mode === "remaining" ? `${label} ${pct}% left` : `${label} ${pct}%`;
}

// ---------------------------------------------------------------------
// Reset-time formatting. `resetsAt` is always Unix epoch SECONDS (see
// context/status-bar.tsx's RateWindow doc comment) — every function below
// takes seconds and an explicit "now" in ms so callers (a ticking
// setInterval in the popover) can drive them without a hidden Date.now()
// dependency, keeping this file fully synchronous/pure for tests.
// ---------------------------------------------------------------------

/** "in 2h 14m" / "in 45m" / "in 3d 4h" / "now" once the window has reset.
 *  Never negative-looking output — anything at or past `resetsAt` reads
 *  "now" rather than "in -5m". */
export function formatCountdown(
  resetsAtSeconds: number,
  nowMs: number = Date.now(),
): string {
  const diffSeconds = resetsAtSeconds - Math.floor(nowMs / 1000);
  if (diffSeconds <= 0) return "now";
  const days = Math.floor(diffSeconds / 86_400);
  const hours = Math.floor((diffSeconds % 86_400) / 3_600);
  const minutes = Math.floor((diffSeconds % 3_600) / 60);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return "in <1m";
}

/** "Tue 10:00"-style absolute timestamp — no new dependency, just
 *  Intl.DateTimeFormat. Locale-formatted, so exact punctuation/AM-PM
 *  varies by the user's locale; that's intentional. */
export function formatResetTimestamp(resetsAtSeconds: number): string {
  const d = new Date(resetsAtSeconds * 1000);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(d);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return `${weekday} ${time}`;
}

export type ResetDisplayMode = "countdown" | "timestamp";

/** Single entry point the popover calls — picks countdown vs. timestamp
 *  per the user's resetDisplay preference. */
export function formatResetTime(
  resetsAtSeconds: number,
  mode: ResetDisplayMode,
  nowMs: number = Date.now(),
): string {
  return mode === "timestamp"
    ? formatResetTimestamp(resetsAtSeconds)
    : formatCountdown(resetsAtSeconds, nowMs);
}

// ---------------------------------------------------------------------
// Staleness (cosmetic-only — never a new Availability value). An
// "available" snapshot gets a muted/60%-opacity treatment plus a clock
// glyph once either the tab has exited, or 5+ minutes have passed since
// the last observation while still "running".
// ---------------------------------------------------------------------

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function isStale(
  tabStatus: "opening" | "running" | "exited" | "error",
  observedAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (tabStatus === "exited") return true;
  return nowMs - observedAtMs > STALE_THRESHOLD_MS;
}

// ---------------------------------------------------------------------
// Tooltip copy for the two distinct "unavailable" causes. Both the
// compact bar and the popover need the exact same wording, so it lives
// here once. `rateLimitAvailability` collapses these to a single enum
// value; the caller re-derives which of the two applies by checking
// `overlayInstalled` directly, per the task's own note that this is safe
// to do without re-deriving the enum's logic.
// ---------------------------------------------------------------------

export function modelContextUnavailableTooltip(): string {
  return "Status bar couldn't start for this session";
}

export function rateLimitUnavailableTooltip(overlayInstalled: boolean): string {
  return overlayInstalled
    ? "This profile is billed by API key — usage windows don't apply"
    : "Status bar couldn't start for this session";
}

// ---------------------------------------------------------------------
// Profile labeling. NEVER render a raw profileId ("custom:base64...") in
// any UI — these are the two shapes callers are allowed to show instead.
// ---------------------------------------------------------------------

/** Always returns a non-empty, human-safe label — used wherever a label
 *  MUST render something (footer alias prefix, popover profile header):
 *  the user's alias if set, else "Default" for the literal "default"
 *  profileId, else the generic "Unnamed profile" placeholder. */
export function profileDisplayLabel(
  profileId: string | undefined,
  aliases: Record<string, string>,
): string {
  if (!profileId) return "Unnamed profile";
  const alias = aliases[profileId];
  if (alias && alias.trim()) return alias;
  return profileId === "default" ? "Default" : "Unnamed profile";
}

/** Label for a profile's row in the Settings view's alias-editor list —
 *  allowed to be blank (an anonymous custom profile with no alias yet
 *  renders with only its input visible, no placeholder label text next
 *  to it, so nothing on screen ever reads like a "custom:..." id). */
export function profileRowLabel(
  profileId: string,
  aliases: Record<string, string>,
): string {
  const alias = aliases[profileId];
  if (alias && alias.trim()) return alias;
  return profileId === "default" ? "Default" : "";
}

// ---------------------------------------------------------------------
// aria-label for the usage-cluster trigger button.
// ---------------------------------------------------------------------

export function usageAriaLabel(params: {
  availability: Availability;
  alias?: string;
  fiveHourUsedPercentage?: number | null;
  weeklyUsedPercentage?: number | null;
  mode: UsageDisplayMode;
}): string {
  const prefix = params.alias ? `${params.alias} usage` : "Usage";
  if (params.availability === "waiting") return `${prefix}: waiting for data`;
  if (params.availability === "unavailable") return `${prefix}: not available`;
  const parts: string[] = [];
  if (params.fiveHourUsedPercentage != null) {
    parts.push(formatUsagePart("5 hour window", params.fiveHourUsedPercentage, params.mode));
  }
  if (params.weeklyUsedPercentage != null) {
    parts.push(formatUsagePart("weekly window", params.weeklyUsedPercentage, params.mode));
  }
  return `${prefix}: ${parts.length > 0 ? parts.join(", ") : "no data"}`;
}
