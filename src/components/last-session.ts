const PREFIX = "lastSessionId:";

/** Pre-profile-aware key. Only ever consulted for the "default" profile,
 *  and only until it's been validated once — see `lib/auto-resume.ts`. */
export function legacyLastSessionKey(projectPath: string): string {
  return PREFIX + projectPath;
}

export function lastSessionKey(projectPath: string, profileId: string): string {
  return `${PREFIX}${projectPath}:${profileId}`;
}

export function getLastSessionId(
  projectPath: string,
  profileId: string,
): string | null {
  try {
    return localStorage.getItem(lastSessionKey(projectPath, profileId));
  } catch {
    return null;
  }
}

export function setLastSessionId(
  projectPath: string,
  profileId: string,
  sessionId: string | null,
): void {
  const k = lastSessionKey(projectPath, profileId);
  try {
    if (sessionId) localStorage.setItem(k, sessionId);
    else localStorage.removeItem(k);
  } catch {
    // ignore — private browsing / quota.
  }
}

/** Reads the legacy unnamespaced pointer. Callers must only use this for
 *  the "default" profile — a custom profile must never read it. */
export function getLegacyLastSessionId(projectPath: string): string | null {
  try {
    return localStorage.getItem(legacyLastSessionKey(projectPath));
  } catch {
    return null;
  }
}

/** Removes the legacy pointer once its value has been validated and (if
 *  still valid) rewritten under the namespaced default key, so it can't
 *  resurrect a stale session id on a later launch. Only ever removes the
 *  local pointer — never touches Claude's own session data on disk. */
export function clearLegacyLastSessionId(projectPath: string): void {
  try {
    localStorage.removeItem(legacyLastSessionKey(projectPath));
  } catch {
    // ignore — private browsing / quota.
  }
}
