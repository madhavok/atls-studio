import { describe, expect, it } from 'vitest';
import { rehydrateDate } from './persistenceHelpers';

describe('rehydrateDate', () => {
  it('returns valid Date instances', () => {
    const d = new Date('2024-06-01T12:00:00Z');
    expect(rehydrateDate(d).getTime()).toBe(d.getTime());
  });

  it('parses iso string and number', () => {
    const s = rehydrateDate('2020-01-02');
    expect(s.getUTCFullYear()).toBe(2020);
    expect(rehydrateDate(0).getTime()).toBe(0);
  });

  it('falls back to epoch for garbage', () => {
    expect(rehydrateDate(null).getTime()).toBe(0);
    expect(rehydrateDate('not a date').getTime()).toBe(0);
  });
});
