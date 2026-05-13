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
  // `annotate.engram` / `eng` was retired — `annotate.note` (nn) is the one
  // annotate verb and already accepts both `note` and `fields`.
  if (useRaw === 'annotate.engram' || useRaw.toLowerCase() === 'eng') {
    return ' — `annotate.engram` was retired; use `annotate.note` (nn) with `fields:{...}` for metadata edits (same function).';
  }
  return '';
}

export type BatchStepLike = { id?: unknown; use?: unknown; with?: unknown };

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
    let normalized: string | null = null;
    if (!deferredToExecutor) {
      normalized = normalizeOperationUse(useRaw.toLowerCase()) as string;
      if (!CANONICAL_OPS.has(normalized)) {
        const hint = hintForUnknownOp(useRaw);
        return {
          ok: false,
          error: `unknown operation at step ${id}: "${useRaw}"${hint}`,
        };
      }
    }
    // replace_body must be the sole entry in its line_edits array. The
    // intra-step rebase math (computeSingleEditNetDelta) can't compute a
    // positional delta for replace_body until Rust backfills
    // _resolved_body_span post-apply (see executor.ts ~L258-266), so any
    // sibling le entry below the replace_body would shift by the wrong
    // amount and silently corrupt the file. Enforce sole-occupant here
    // to convert silent-corruption into a clear pre-dispatch error.
    if (normalized === 'change.edit') {
      const w = step.with as Record<string, unknown> | undefined;
      if (w) {
        const top = w.line_edits;
        if (Array.isArray(top) && top.length > 1
            && top.some(le => le && typeof le === 'object' && (le as Record<string, unknown>).action === 'replace_body')) {
          return {
            ok: false,
            error: `change.edit step "${id}" mixes replace_body with sibling line_edits entries; replace_body must be the only entry in its step`,
          };
        }
        if (w.mode === 'batch_edits' && Array.isArray(w.edits)) {
          for (let j = 0; j < (w.edits as unknown[]).length; j++) {
            const ed = (w.edits as Record<string, unknown>[])[j];
            const le = ed?.line_edits;
            if (Array.isArray(le) && le.length > 1
                && le.some(e => e && typeof e === 'object' && (e as Record<string, unknown>).action === 'replace_body')) {
              return {
                ok: false,
                error: `change.edit step "${id}" mixes replace_body with sibling line_edits entries in edits[${j}]; replace_body must be the only entry in its sub-edit`,
              };
            }
          }
        }
      }
    }
  }
  return { ok: true };
}
