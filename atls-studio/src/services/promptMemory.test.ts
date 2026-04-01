import { describe, it, expect } from 'vitest';
import { TOTAL_ROUND_SOFT_BUDGET, TOTAL_ROUND_ESCALATION } from './promptMemory';

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
