import { describe, expect, it } from 'vitest';
import { commonPrefixLen } from './contextHelpers';

describe('commonPrefixLen', () => {
  it('returns full length when equal', () => {
    expect(commonPrefixLen('abc', 'abc')).toBe(3);
  });

  it('stops at first mismatch', () => {
    expect(commonPrefixLen('abx', 'aby')).toBe(2);
  });

  it('handles empty and prefix', () => {
    expect(commonPrefixLen('', 'x')).toBe(0);
    expect(commonPrefixLen('pre', 'prefix')).toBe(3);
  });
});
