import { describe, expect, it } from 'vitest';
import { evaluateCondition, MAX_BATCH_POLICY_STEPS, normalizeBatchPolicyForExecution } from './policy';
import type { StepOutput } from './types';

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
});
