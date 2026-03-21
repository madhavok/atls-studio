/**
 * Normalize `batch({ steps })` when models stringify `steps` as JSON instead of an array.
 * Prevents `steps.find is not a function` when runtime code expects an array.
 */
export function coerceBatchSteps(raw: unknown): Record<string, unknown>[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object' && !Array.isArray(s));
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object' && !Array.isArray(s));
      }
    } catch {
      /* invalid JSON */
    }
  }
  return [];
}
