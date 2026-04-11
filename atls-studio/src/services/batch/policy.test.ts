import { describe, expect, it } from 'vitest';
import {
  collectRollbackTargets,
  evaluateCondition,
  getAutoVerifySteps,
  isBlockedForSwarm,
  isStepAllowed,
  isStepCountExceeded,
  MAX_BATCH_POLICY_STEPS,
  normalizeBatchPolicyForExecution,
} from './policy';
import type { Step, StepOutput } from './types';

describe('normalizeBatchPolicyForExecution', () => {
  it('forces readonly in Ask mode', () => {
    expect(normalizeBatchPolicyForExecution(true, undefined)).toEqual({ mode: 'readonly' });
    expect(normalizeBatchPolicyForExecution(true, { mode: 'mutable', max_steps: 5 })).toEqual({
      mode: 'readonly',
      max_steps: 5,
    });
  });

  it('forces mutable for agent modes and drops model readonly', () => {
    expect(normalizeBatchPolicyForExecution(false, { mode: 'readonly' })).toEqual({ mode: 'mutable' });
    expect(normalizeBatchPolicyForExecution(false, { mode: 'safe-mutable', verify_after_change: true })).toEqual({
      mode: 'mutable',
      verify_after_change: true,
    });
  });

  it('returns undefined when no policy in agent mode', () => {
    expect(normalizeBatchPolicyForExecution(false, undefined)).toBeUndefined();
  });

  it('clamps max_steps', () => {
    expect(
      normalizeBatchPolicyForExecution(false, { max_steps: MAX_BATCH_POLICY_STEPS + 50 }),
    ).toEqual({ mode: 'mutable', max_steps: MAX_BATCH_POLICY_STEPS });
    expect(normalizeBatchPolicyForExecution(false, { max_steps: 0 })).toEqual({ mode: 'mutable', max_steps: 1 });
  });
});

describe('evaluateCondition', () => {
  it('accepts string shorthand (e1.ok) without throwing', () => {
    const outputs = new Map<string, StepOutput>([
      ['e1', { ok: true, refs: [] }],
    ]);
    expect(evaluateCondition('e1.ok', outputs)).toBe(true);
  });

  it('step_ok, step_has_refs, ref_exists, all_steps_ok, not', () => {
    const outputs = new Map<string, StepOutput>([
      ['a', { ok: false, refs: [] }],
      ['b', { ok: true, refs: ['h:deadbeef'] }],
      ['c', { ok: true, refs: [] }],
    ]);
    expect(evaluateCondition({ step_ok: 'a' }, outputs)).toBe(false);
    expect(evaluateCondition({ step_ok: 'b' }, outputs)).toBe(true);
    expect(evaluateCondition({ step_has_refs: 'b' }, outputs)).toBe(true);
    expect(evaluateCondition({ step_has_refs: 'c' }, outputs)).toBe(false);
    expect(evaluateCondition({ ref_exists: 'h:deadbeef' }, outputs)).toBe(true);
    expect(evaluateCondition({ ref_exists: 'deadbeef' }, outputs)).toBe(true);
    expect(evaluateCondition({ ref_exists: 'cafe' }, outputs)).toBe(false);
    expect(evaluateCondition({ all_steps_ok: ['b', 'c'] }, outputs)).toBe(true);
    expect(evaluateCondition({ all_steps_ok: ['a', 'b'] }, outputs)).toBe(false);
    expect(evaluateCondition({ not: { step_ok: 'a' } }, outputs)).toBe(true);
    expect(evaluateCondition({ not: { step_ok: 'b' } }, outputs)).toBe(false);
  });
});

describe('isStepAllowed', () => {
  it('allows all when mutable', () => {
    expect(isStepAllowed({ id: 'x', use: 'change.edit', with: {} }, { mode: 'mutable' })).toEqual({ allowed: true });
  });

  it('blocks mutating ops in readonly', () => {
    const r = isStepAllowed({ id: 'x', use: 'change.edit', with: {} }, { mode: 'readonly' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/blocked by readonly/);
  });
});

describe('getAutoVerifySteps', () => {
  it('returns verify.build after mutating op when verify_after_change', () => {
    const steps = getAutoVerifySteps('s1', 'change.edit', { verify_after_change: true, stop_on_verify_failure: false });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.use).toBe('verify.build');
    expect(steps[0]?.on_error).toBe('continue');
  });

  it('uses on_error stop when stop_on_verify_failure', () => {
    const steps = getAutoVerifySteps('s1', 'change.edit', { verify_after_change: true, stop_on_verify_failure: true });
    expect(steps[0]?.on_error).toBe('stop');
  });

  it('empty for non-mutating or flag off', () => {
    expect(getAutoVerifySteps('s1', 'read.lines', { verify_after_change: true })).toEqual([]);
    expect(getAutoVerifySteps('s1', 'change.edit', {})).toEqual([]);
  });
});

describe('isStepCountExceeded', () => {
  it('respects max_steps', () => {
    expect(isStepCountExceeded(4, { max_steps: 5 })).toBe(false);
    expect(isStepCountExceeded(5, { max_steps: 5 })).toBe(true);
    expect(isStepCountExceeded(0, undefined)).toBe(false);
  });
});

describe('collectRollbackTargets', () => {
  it('lists ok mutating step ids in order', () => {
    const steps: Step[] = [
      { id: 'r1', use: 'read.lines', with: {} },
      { id: 'm1', use: 'change.edit', with: {} },
      { id: 'm2', use: 'change.create', with: {} },
    ];
    const results = new Map<string, StepOutput>([
      ['m1', { ok: true, refs: [] }],
      ['m2', { ok: false, refs: [] }],
    ]);
    expect(collectRollbackTargets(results, steps)).toEqual(['m1']);
  });
});

describe('isBlockedForSwarm', () => {
  it('blocks session plan/advance for swarm workers', () => {
    expect(isBlockedForSwarm('session.plan')).toBe(true);
    expect(isBlockedForSwarm('session.advance')).toBe(true);
    expect(isBlockedForSwarm('read.lines')).toBe(false);
  });
});
