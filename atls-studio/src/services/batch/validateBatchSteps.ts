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

/** Targeted hint for the most common "invented op" mistakes we observe. */
function hintForUnknownOp(useRaw: string): string {
  if (/^subtask[.:_-]/i.test(useRaw) || /^subtask$/i.test(useRaw)) {
    return ' — there is no subtask:* operation; use session.advance (sa) with subtask:<id> summary:"<findings>"';
  }
  return '';
}

/** Minimal shape for validation (matches `Step` and loose JSON from tool args). */
export type BatchStepLike = { id?: unknown; use?: unknown };

/** Minimal shape for envelope-level validation (tool_use input as received). */
export type BatchEnvelopeLike = Record<string, unknown> & {
  steps?: unknown;
  q?: unknown;
  _stubbed?: unknown;
  _compressed?: unknown;
};

/**
 * Validate the batch tool_use envelope before step-level validation runs.
 *
 * Rejects inputs that would otherwise slip through as a silent 0-step batch:
 *  - `_stubbed` / `_compressed` sentinels: these are post-hoc history-compression
 *    artifacts (see stubBatchToolUseInputs in historyCompressor.ts). When the
 *    model echoes them as a new tool call (template calcification), the batch
 *    was historically accepted as empty-and-ok. Reject with a steering error
 *    pointing back to BATCH_TOOL_REF.
 *  - Empty steps array with no `q` string: nothing to execute; almost certainly
 *    a malformed or calcified call.
 */
export function validateBatchEnvelope(input: BatchEnvelopeLike): ValidateBatchStepsResult {
  if (input._stubbed !== undefined || input._compressed !== undefined) {
    return {
      ok: false,
      error: 'empty/stubbed envelope; emit real steps (see BATCH_TOOL_REF). `_stubbed`/`_compressed` are post-hoc compression markers, not a callable shape.',
    };
  }
  const hasSteps = Array.isArray(input.steps) && input.steps.length > 0;
  const hasQ = typeof input.q === 'string' && input.q.trim().length > 0;
  if (!hasSteps && !hasQ) {
    return {
      ok: false,
      error: 'empty batch envelope; provide `steps` array or `q:` DSL block (see BATCH_TOOL_REF).',
    };
  }
  return { ok: true };
}

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
        const hint = hintForUnknownOp(useRaw);
        return {
          ok: false,
          error: `unknown operation at step ${id}: "${useRaw}"${hint}`,
        };
      }
    }
  }
  return { ok: true };
}
