export type SessionLike = {
  id: string;
  custom_title?: string | null;
  summary?: string | null;
  first_message_preview?: string | null;
};

const MAX_LABEL = 40;

function clamp(s: string, max = MAX_LABEL): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

/** Preference: user-set custom title > auto summary > first user prompt > short id. */
export function displayLabel(s: SessionLike): string {
  if (s.custom_title && s.custom_title.trim()) return clamp(s.custom_title);
  if (s.summary && s.summary.trim()) return clamp(s.summary);
  if (s.first_message_preview && s.first_message_preview.trim()) {
    return clamp(s.first_message_preview);
  }
  return `session ${s.id.slice(0, 8)}`;
}
