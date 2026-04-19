const PREFIX = "lastSessionId:";

export function lastSessionKey(projectPath: string): string {
  return PREFIX + projectPath;
}

export function getLastSessionId(projectPath: string): string | null {
  try {
    return localStorage.getItem(lastSessionKey(projectPath));
  } catch {
    return null;
  }
}

export function setLastSessionId(
  projectPath: string,
  sessionId: string | null,
): void {
  const k = lastSessionKey(projectPath);
  try {
    if (sessionId) localStorage.setItem(k, sessionId);
    else localStorage.removeItem(k);
  } catch {
    // ignore — private browsing / quota.
  }
}
