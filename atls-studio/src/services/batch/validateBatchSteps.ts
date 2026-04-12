/**
 * Fail-fast validation for user-supplied batch steps (JSON or line-expanded).
 * Catches markdown/prose mistaken for step ids and unknown operation tokens early.
 */

import { SHORT_TO_OP, normalizeOperationUse } from './opShorthand';

/** Canonical operation names (values of shorthand map cover all OperationKind entries). */
const CANONICAL_OPS = new Set<string>(Object.values(SHORT_TO_OP));

const MAX_STEP_ID_LEN = 256;

function isValidStepId(id: string): boolean {
  if (!id || id.length > MAX_STEP_ID_LEN) return false;
  if (/[`\n\r]/.test(id)) return false;
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(id);
}

export type ValidateBatchStepsResult = { ok: true } | { ok: false; error: string };

/** Minimal shape for validation (matches `Step` and loose JSON from tool args). */
export type BatchStepLike = { id?: unknown; use?: unknown };

/**
 * Validate raw step objects before intent expansion. Returns first error or ok.
 */
export function validateBatchSteps(steps: ReadonlyArray<BatchStepLike>): ValidateBatchStepsResult {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const id = typeof step.id === 'string' ? step.id : '';
    if (!isValidStepId(id)) {
      const preview = JSON.stringify(id).slice(0, 96);
      return {
        ok: false,
        error:
          `invalid step id at index ${i}: use a short identifier (start with a letter; only letters, digits, ._-); no markdown, backticks, or numbered-outline tokens (got ${preview})`,
      };
    }
    const useRaw = typeof step.use === 'string' ? step.use.trim() : '';
    if (!useRaw) {
      return { ok: false, error: `missing operation (use) at step ${id}` };
    }
    // Let the executor emit rich errors for doc-token mistakes vs OpenAI wrappers.
    const deferredToExecutor =
      useRaw.toUpperCase() === 'USE' || useRaw.startsWith('multi_tool_use.');
    if (!deferredToExecutor) {
      const normalized = normalizeOperationUse(useRaw.toLowerCase()) as string;
      if (!CANONICAL_OPS.has(normalized)) {
        return {
          ok: false,
          error: `unknown operation at step ${id}: "${useRaw}"`,
        };
      }
    }
  }
  return { ok: true };
}
