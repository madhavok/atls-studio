import { describe, expect, it } from 'vitest';
import { shiftLineRangeSpec } from './lineDeltaDrift';

describe('shiftLineRangeSpec', () => {
  it('shifts single line and ranges', () => {
    expect(shiftLineRangeSpec('3', 2)).toBe('5');
    expect(shiftLineRangeSpec('2-4', 1)).toBe('3-5');
    expect(shiftLineRangeSpec('1-2, 10', -1)).toBe('1-1,9');
  });

  it('clamps to line 1 when delta pulls start below 1', () => {
    expect(shiftLineRangeSpec('2-5', -5)).toBe('1-1');
  });
});
