import { describe, it, expect } from 'vitest';
import {
  TOTAL_ROUND_SOFT_BUDGET,
  TOTAL_ROUND_ESCALATION,
  isPersistentAnchorKey,
  classifyStageSnippet,
} from './promptMemory';

describe('convergence guard constants', () => {
  it('TOTAL_ROUND_SOFT_BUDGET is 6', () => {
    expect(TOTAL_ROUND_SOFT_BUDGET).toBe(6);
  });

  it('TOTAL_ROUND_ESCALATION is 8', () => {
    expect(TOTAL_ROUND_ESCALATION).toBe(8);
  });

  it('escalation > soft budget', () => {
    expect(TOTAL_ROUND_ESCALATION).toBeGreaterThan(TOTAL_ROUND_SOFT_BUDGET);
  });
});

describe('isPersistentAnchorKey / classifyStageSnippet', () => {
  it('isPersistentAnchorKey matches entry and edit prefixes', () => {
    expect(isPersistentAnchorKey('entry:foo')).toBe(true);
    expect(isPersistentAnchorKey('edit:bar')).toBe(true);
    expect(isPersistentAnchorKey('other:baz')).toBe(false);
  });

  it('classifyStageSnippet uses persistent anchor path for entry keys', () => {
    const small = classifyStageSnippet('entry:x', 50);
    expect(small.admissionClass).toBe('persistentAnchor');
    const other = classifyStageSnippet('note:x', 50);
    expect(other.admissionClass).toBe('transientAnchor');
  });
});
