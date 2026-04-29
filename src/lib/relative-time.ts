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
