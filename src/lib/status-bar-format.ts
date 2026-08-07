// Pure, framework-free helpers backing the status-bar footer + popover
// (components/status-bar.tsx, components/status-bar-popover.tsx). Kept
// import-free of any @/context module — mirrors the rest of lib/ (e.g.
// lib/session-label.ts's local SessionLike) so these stay independently
// testable and don't couple the lib layer to Solid context internals. The
// `Availability` union below is structurally identical to (and interops
// freely with) context/status-bar's own exported type.

import type { UsageBarsPreference } from "./status-bar-prefs";

export type Availability = "waiting" | "available" | "unavailable";

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
// Usage progress bars (5-hour / weekly). Always represent percentage
// USED — matching the popover's Rows, which already hardcode "used"
// regardless of the showAsRemainingVsUsed preference (see
// status-bar-popover.tsx's ProfileView) — so the bar's fill and the
// preference toggle never disagree about which direction is "full".
// ---------------------------------------------------------------------

/** Defensive clamp for anything rendered as a percentage width or
 *  aria-valuenow. Upstream data is expected to already be within range,
 *  but nothing downstream should ever render a >100%-wide bar or a
 *  negative one from a stray bad payload. */
export function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** The single rounded, clamped 0-100 integer used for a bar's fill
 *  width and its visible percentage text — NOT for severity color,
 *  which must use the raw, unrounded percentage instead (see
 *  `contextBarColorClass`'s own callers) so a borderline value like
 *  90.4% can't round down into the wrong color bucket. Also backs
 *  aria-valuenow, so width/text/aria-valuenow never drift apart.
 *  Missing-window handling ("no data" must never render as a 0%-full
 *  bar) is enforced by the `<Show>` guard each caller already wraps its
 *  bar in — this function only ever receives an already-known-present
 *  percentage. */
export function usageBarValue(usedPercentage: number): number {
  return Math.round(clampPercentage(usedPercentage));
}

/** e.g. "Weekly usage: 90 percent used" — `label` is the caller-supplied
 *  full window name ("5-hour usage", "Weekly usage"). */
export function usageBarAriaLabel(label: string, usedPercentage: number): string {
  return `${label}: ${usageBarValue(usedPercentage)} percent used`;
}

/** Extra-wide breakpoint gating the "auto" progress-bar presentation — a
 *  label + bar + percentage per window needs more room than the plain
 *  "5h 31% · Week 12%" text it replaces. Unlike a generic responsive grid,
 *  this is the footer's only real narrowing behavior: with the app's
 *  `minWidth: 900` and the sidebar capped at 280px, the footer's own width
 *  never drops far enough to threaten any *section's* visibility, but it
 *  does swing across this specific threshold. */
export const USAGE_BARS_MIN_WIDTH = 640;

export function wideEnoughForUsageBars(width: number): boolean {
  return width >= USAGE_BARS_MIN_WIDTH;
}

/** Whether the usage cluster should render bars instead of its
 *  text-only fallback, per the `usageBars` preference. Callers only
 *  invoke this once the usage section itself is already known to be
 *  visible (see `showUsageSection`) — "always" intentionally ignores
 *  `width` entirely, matching "show bars whenever
 *  the usage section itself is visible". */
export function shouldShowUsageBars(
  preference: UsageBarsPreference,
  width: number,
): boolean {
  if (preference === "never") return false;
  if (preference === "always") return true;
  return wideEnoughForUsageBars(width);
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
