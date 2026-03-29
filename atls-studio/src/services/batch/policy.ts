/**
 * Execution Policy — enforcement logic for mode gating, auto-behaviors,
 * conditional step evaluation, and rollback.
 */

import type { ExecutionPolicy, OperationKind, ConditionExpr, StepOutput, Step } from './types';
import { isMutatingOp, isReadonlyOp } from './opMap';
import { expandBatchIfShorthand } from '../../utils/toon';

// ---------------------------------------------------------------------------
// Mode gating
// ---------------------------------------------------------------------------

/** Upper bound for model-supplied max_steps (reduces runaway / stuck batches). */
export const MAX_BATCH_POLICY_STEPS = 100;

/**
 * Chat/tool-layer policy normalization. Ask mode is read-only (app-enforced).
 * All other chat modes ignore model-supplied `policy.mode` and run as mutable.
 */
export function normalizeBatchPolicyForExecution(
  isAskMode: boolean,
  policy: ExecutionPolicy | undefined,
): ExecutionPolicy | undefined {
  if (isAskMode) {
    return { ...policy, mode: 'readonly' };
  }
  if (!policy) {
    return undefined;
  }
  const next: ExecutionPolicy = { ...policy, mode: 'mutable' };
  if (next.max_steps !== undefined) {
    if (next.max_steps > MAX_BATCH_POLICY_STEPS) {
      next.max_steps = MAX_BATCH_POLICY_STEPS;
    }
    if (next.max_steps < 1) {
      next.max_steps = 1;
    }
  }
  return next;
}

export function isStepAllowed(
  step: Step,
  policy: ExecutionPolicy | undefined,
): { allowed: boolean; reason?: string } {
  if (!policy?.mode || policy.mode === 'mutable') return { allowed: true };

  const op = step.use;

  if (policy.mode === 'readonly') {
    if (isMutatingOp(op)) {
      return { allowed: false, reason: `${op} blocked by readonly policy` };
    }
  }

  // safe-mutable allows mutations but verify_after_change may inject steps
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Auto-verify insertion
// ---------------------------------------------------------------------------

/**
 * Given a completed change step, returns the verify steps to auto-insert
 * when `verify_after_change` is enabled.
 */
export function getAutoVerifySteps(
  stepId: string,
  op: OperationKind,
  policy: ExecutionPolicy | undefined,
): Step[] {
  if (!policy?.verify_after_change) return [];
  if (!isMutatingOp(op)) return [];

  return [{
    id: `${stepId}__auto_verify`,
    use: 'verify.build',
    with: {},
    on_error: policy.stop_on_verify_failure ? 'stop' : 'continue',
  }];
}

// ---------------------------------------------------------------------------
// Max steps enforcement
// ---------------------------------------------------------------------------

export function isStepCountExceeded(
  currentIndex: number,
  policy: ExecutionPolicy | undefined,
): boolean {
  if (!policy?.max_steps) return false;
  return currentIndex >= policy.max_steps;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

export function evaluateCondition(
  cond: ConditionExpr | string,
  stepOutputs: ReadonlyMap<string, StepOutput>,
): boolean {
  if (typeof cond === 'string') {
    return evaluateCondition(expandBatchIfShorthand(cond) as ConditionExpr, stepOutputs);
  }
  if ('step_ok' in cond) {
    const output = stepOutputs.get(cond.step_ok);
    return output?.ok === true;
  }
  if ('step_has_refs' in cond) {
    const output = stepOutputs.get(cond.step_has_refs);
    return (output?.refs?.length ?? 0) > 0;
  }
  if ('ref_exists' in cond) {
    const refHash = (cond as { ref_exists: string }).ref_exists;
    // Check all step outputs for a matching ref (prefix match)
    const normalized = refHash.startsWith('h:') ? refHash.slice(2) : refHash;
    for (const [, output] of stepOutputs) {
      if (output.refs?.some(r => r.startsWith(normalized) || r.includes(normalized))) {
        return true;
      }
    }
    return false;
  }
  if ('all_steps_ok' in cond) {
    const ids = (cond as { all_steps_ok: string[] }).all_steps_ok;
    return ids.every(id => stepOutputs.get(id)?.ok === true);
  }
  if ('not' in cond) {
    return !evaluateCondition(cond.not, stepOutputs);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rollback collection
// ---------------------------------------------------------------------------

/**
 * Collects step IDs that performed successful mutations and may need rollback.
 */
export function collectRollbackTargets(
  stepResults: ReadonlyMap<string, StepOutput>,
  steps: Step[],
): string[] {
  const targets: string[] = [];
  for (const step of steps) {
    if (isMutatingOp(step.use)) {
      const output = stepResults.get(step.id);
      if (output?.ok) targets.push(step.id);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Swarm agent restrictions
// ---------------------------------------------------------------------------

const SWARM_BLOCKED_OPS = new Set<OperationKind>(['session.plan', 'session.advance']);

export function isBlockedForSwarm(op: OperationKind): boolean {
  return SWARM_BLOCKED_OPS.has(op);
}
