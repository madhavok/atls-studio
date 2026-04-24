import { expandBatchIfShorthand } from '../../utils/toon';
import { normalizeOperationUse } from './opShorthand';

/**
 * When model JSON puts dataflow inside `with.hashes` as `"in:stepId[.path]"`
 * instead of using `step.in`, promote it to `step.in.hashes` so the executor's
 * binding resolver picks it up. Mirrors the rewrite the q: line parser does
 * (see toon.ts::parseBatchLines). Idempotent — skips when dataflow is lossy
 * (commas / chained `in:`) or when `step.in.hashes` is already set.
 */
function rescueDataflowInHashes(step: Record<string, unknown>): void {
  const w = step.with;
  if (!w || typeof w !== 'object' || Array.isArray(w)) return;
  const withObj = w as Record<string, unknown>;
  const h = withObj.hashes;
  if (typeof h !== 'string' || !h.startsWith('in:')) return;
  const dataflow = h.slice(3).trim();
  if (!dataflow) return;
  const lossy = dataflow.includes(',') || dataflow.includes(' in:');
  const looksLikeDataflow = !lossy
    && (/\.(refs|ok)$/.test(dataflow) || !dataflow.includes(':'));
  if (!looksLikeDataflow) return;

  const dotIdx = dataflow.indexOf('.');
  const fromStep = dotIdx === -1 ? dataflow : dataflow.slice(0, dotIdx);
  const path = dotIdx === -1 ? 'refs' : dataflow.slice(dotIdx + 1);

  const existingIn = step.in;
  const inObj: Record<string, unknown> =
    existingIn && typeof existingIn === 'object' && !Array.isArray(existingIn)
      ? { ...(existingIn as Record<string, unknown>) }
      : {};
  if (inObj.hashes === undefined) {
    inObj.hashes = { from_step: fromStep, path };
  }
  step.in = inObj;
  delete withObj.hashes;
}

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
    if (typeof step.use === 'string') {
      step.use = normalizeOperationUse(step.use);
    }
    const iff = step.if;
    if (typeof iff === 'string') {
      step.if = expandBatchIfShorthand(iff);
    }
    rescueDataflowInHashes(step);
  }
  return steps;
}
