/**
 * Deterministic / property-style coverage for line-range parsing and relocation
 * (used by the freshness rebase cascade).
 */
import { describe, expect, it } from 'vitest';
import { parseLineRanges, relocateLineRanges } from './freshnessPreflight';

describe('parseLineRanges', () => {
  it('parses single line, range, open end, and comma-separated segments', () => {
    expect(parseLineRanges('5')).toEqual([[5, 5]]);
    expect(parseLineRanges('5-10')).toEqual([[5, 10]]);
    expect(parseLineRanges('5-')).toEqual([[5, undefined]]);
    expect(parseLineRanges('1-2, 4')).toEqual([[1, 2], [4, 4]]);
    expect(parseLineRanges('  10 - 12  , 15')).toEqual([[10, 12], [15, 15]]);
  });

  it('returns null for invalid specs', () => {
    expect(parseLineRanges('')).toBeNull();
    expect(parseLineRanges('abc')).toBeNull();
    expect(parseLineRanges('1-x')).toBeNull();
  });
});

describe('relocateLineRanges', () => {
  it('returns original range when content at that span still matches the block', () => {
    const content = 'a\nb\nc\nd\n';
    const r = relocateLineRanges(content, [[2, 3]]);
    expect(r).toEqual([[2, 3]]);
  });

  it('returns null when original range is out of file bounds', () => {
    const content = 'x\ny\n';
    expect(relocateLineRanges(content, [[10, 10]])).toBeNull();
  });
});
