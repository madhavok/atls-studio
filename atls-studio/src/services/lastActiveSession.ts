/**
 * Persists which chat session was last active per project so cold start can auto-resume.
 */

const LS_KEY = 'atls:last-active-session-by-project-v1';

function readMap(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

export function readLastActiveSessionId(projectPath: string): string | null {
  if (!projectPath) return null;
  const map = readMap();
  const id = map[projectPath];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function writeLastActiveSessionId(projectPath: string, sessionId: string | null): void {
  if (!projectPath) return;
  const map = readMap();
  if (sessionId === null) {
    delete map[projectPath];
  } else {
    map[projectPath] = sessionId;
  }
  writeMap(map);
}

/** Batch / tool code reads `current_session_id` for hash lookups — keep aligned with app chat session. */
export function syncCurrentSessionIdToLocalStorage(sessionId: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (sessionId) localStorage.setItem('current_session_id', sessionId);
    else localStorage.removeItem('current_session_id');
  } catch {
    /* ignore */
  }
}
