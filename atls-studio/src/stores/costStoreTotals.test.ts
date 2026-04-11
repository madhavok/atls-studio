import { describe, expect, it } from 'vitest';
import {
  accumulateTotals,
  createEmptyTotals,
  createProviderTotalsRecord,
  groupUsageByProvider,
  sumUsageTotals,
  type UsageRecord,
} from './costStoreTotals';

describe('costStoreTotals', () => {
  it('createEmptyTotals zeros', () => {
    expect(createEmptyTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      requestCount: 0,
    });
  });

  it('accumulateTotals adds usage', () => {
    const t = createEmptyTotals();
    accumulateTotals(t, { inputTokens: 1, outputTokens: 2, estimatedCost: 0.5 });
    accumulateTotals(t, { inputTokens: 3, outputTokens: 0, estimatedCost: 0.1 });
    expect(t).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      estimatedCost: 0.6,
      requestCount: 2,
    });
  });

  it('sumUsageTotals reduces records', () => {
    const records: UsageRecord[] = [
      { inputTokens: 10, outputTokens: 5, estimatedCost: 1 },
      { inputTokens: 2, outputTokens: 8, estimatedCost: 0.25 },
    ];
    const s = sumUsageTotals(records);
    expect(s.inputTokens).toBe(12);
    expect(s.outputTokens).toBe(13);
    expect(s.estimatedCost).toBe(1.25);
    expect(s.requestCount).toBe(2);
  });

  it('groupUsageByProvider buckets', () => {
    type P = 'a' | 'b';
    const providers: P[] = ['a', 'b'];
    const grouped = groupUsageByProvider(
      [
        { provider: 'a', inputTokens: 1, outputTokens: 0, estimatedCost: 0 },
        { provider: 'a', inputTokens: 2, outputTokens: 1, estimatedCost: 0.1 },
        { provider: 'b', inputTokens: 0, outputTokens: 3, estimatedCost: 0.2 },
      ],
      providers,
    );
    expect(grouped.a.requestCount).toBe(2);
    expect(grouped.b.requestCount).toBe(1);
    expect(grouped.b.outputTokens).toBe(3);
  });

  it('createProviderTotalsRecord initializes keys', () => {
    const r = createProviderTotalsRecord(['x', 'y'] as const);
    expect(r.x.requestCount).toBe(0);
    expect(r.y.estimatedCost).toBe(0);
  });
});
