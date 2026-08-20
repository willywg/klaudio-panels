/// Format `ms` (Unix epoch millis) as a short relative-time string
/// suitable for compact UI surfaces like the notification bell.
/// Capped at "Nh ago" — anything older than 24h falls back to the
/// shortest absolute calendar form so the row still shows something
/// useful without dragging in `Intl.RelativeTimeFormat` dependencies.
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 30) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/// Commit timestamps, which routinely run older than the days-scale window
/// `relativeTime` was written for. Recent history reads better relative
/// ("3h ago" answers "did Claude just do this?"); past a week the day count
/// stops meaning anything and a calendar date is what you actually want.
export function commitTime(seconds: number, now: number = Date.now()): string {
  const ms = seconds * 1000;
  if (now - ms < 7 * 24 * 60 * 60 * 1000) return relativeTime(ms, now);
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
