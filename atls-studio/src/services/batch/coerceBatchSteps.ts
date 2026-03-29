import { expandBatchIfShorthand } from '../../utils/toon';

/**
 * Normalize `batch({ steps })` when models stringify `steps` as JSON instead of an array.
 * Prevents `steps.find is not a function` when runtime code expects an array.
 * JSON steps may send `if: "e1.ok"` as a string; expand to ConditionExpr like line-per-step `if:e1.ok`.
 */
export function coerceBatchSteps(raw: unknown): Record<string, unknown>[] {
  let steps: Record<string, unknown>[] = [];
  if (raw === undefined || raw === null) {
    return [];
  }
  if (Array.isArray(raw)) {
    steps = raw.filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object' && !Array.isArray(s));
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        steps = parsed.filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object' && !Array.isArray(s));
      }
    } catch {
      /* invalid JSON */
    }
  }
  for (const step of steps) {
    const iff = step.if;
    if (typeof iff === 'string') {
      step.if = expandBatchIfShorthand(iff);
    }
  }
  return steps;
}
