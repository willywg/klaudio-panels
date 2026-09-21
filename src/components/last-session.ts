import { CLAUDE, type AgentId } from "@/lib/agents";

const PREFIX = "lastSessionId:";

/** Pre-profile-aware key. Only ever consulted for Claude's "default"
 *  profile, and only until it's been validated once — see
 *  `lib/auto-resume.ts`. */
export function legacyLastSessionKey(projectPath: string): string {
  return PREFIX + projectPath;
}

/** Profile-aware but pre-agent key. Every one of these was written when
 *  Claude was the only agent, which is what makes reading it under
 *  `CLAUDE` unambiguous — see `getLastSessionId`. */
export function preAgentLastSessionKey(
  projectPath: string,
  profileId: string,
): string {
  return `${PREFIX}${projectPath}:${profileId}`;
}

/** Agent first, so a `localStorage` dump groups by agent and so a key from
 *  an older generation is recognizable at a glance: project paths are
 *  absolute, so anything whose first segment starts with "/" predates this.
 *  Nothing relies on that — the ladder below constructs keys from values it
 *  already has rather than parsing any — but it costs nothing. */
export function lastSessionKey(
  projectPath: string,
  agentId: AgentId,
  profileId: string,
): string {
  return `${PREFIX}${agentId}:${projectPath}:${profileId}`;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore — private browsing / quota.
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore — private browsing / quota.
  }
}

/** Reads the remembered session, migrating the pre-agent key on the way if
 *  that is where the value still lives.
 *
 *  There is no boot-time scan and no key parsing anywhere in this ladder:
 *  by the time a project is opened we know its path, its agent and its
 *  profile, so both spellings can be *constructed*. Parsing would mean
 *  deciding which generation a key belongs to from a string whose middle
 *  segment is a filesystem path that may itself contain a colon.
 *
 *  The pre-agent rung is Claude-only, and safe precisely because it runs
 *  while Claude is the only agent that can have written one. */
export function getLastSessionId(
  projectPath: string,
  agentId: AgentId,
  profileId: string,
): string | null {
  const key = lastSessionKey(projectPath, agentId, profileId);
  const current = read(key);
  if (current) return current;

  if (agentId !== CLAUDE) return null;

  const legacy = read(preAgentLastSessionKey(projectPath, profileId));
  if (!legacy) return null;
  write(key, legacy);
  drop(preAgentLastSessionKey(projectPath, profileId));
  return legacy;
}

export function setLastSessionId(
  projectPath: string,
  agentId: AgentId,
  profileId: string,
  sessionId: string | null,
): void {
  const k = lastSessionKey(projectPath, agentId, profileId);
  if (sessionId) write(k, sessionId);
  else drop(k);
  // A write settles the question for this (project, agent, profile); leaving
  // the older spelling behind would let it resurrect on a later launch if
  // the new key were ever cleared.
  if (agentId === CLAUDE) drop(preAgentLastSessionKey(projectPath, profileId));
}

/** Reads the legacy unnamespaced pointer. Callers must only use this for
 *  Claude's "default" profile — a custom profile, or another agent, must
 *  never read it. */
export function getLegacyLastSessionId(projectPath: string): string | null {
  return read(legacyLastSessionKey(projectPath));
}

/** Removes the legacy pointer once its value has been validated and (if
 *  still valid) rewritten under the namespaced default key, so it can't
 *  resurrect a stale session id on a later launch. Only ever removes the
 *  local pointer — never touches an agent's own session data on disk. */
export function clearLegacyLastSessionId(projectPath: string): void {
  drop(legacyLastSessionKey(projectPath));
}
