import { describe, expect, it } from 'vitest';
import { tierChip, tierLabel, tierTooltip, type MetricTier } from './metricsLabels';

describe('metricsLabels', () => {
  it('tierLabel prepends the tier', () => {
    expect(tierLabel('billed', 'session input')).toBe('BILLED: session input');
    expect(tierLabel('estimated', 'foo')).toBe('EST: foo');
  });

  it('tierTooltip prepends when first line has no tier prefix', () => {
    expect(
      tierTooltip('billed', ['line1', 'line2']),
    ).toBe('BILLED: line1\nline2');
    expect(
      tierTooltip('estimated', ['a']),
    ).toBe('EST: a');
  });

  it('tierTooltip is idempotent when first line already has tier', () => {
    const t1 = 'BILLED: x\ny';
    expect(
      tierTooltip('estimated', t1.split('\n')),
    ).toBe(t1);
    const t2 = 'EST: only';
    expect(
      tierTooltip('billed', t2.split('\n')),
    ).toBe(t2);
  });

  it('tierTooltip handles empty lines (defaults rest to empty string)', () => {
    expect(tierTooltip('billed', []).split('\n')[0]).toBe('BILLED: ');
  });

  it('tierChip returns short tags', () => {
    expect(tierChip('billed' as MetricTier)).toBe('billed');
    expect(tierChip('estimated')).toBe('est');
  });
});
