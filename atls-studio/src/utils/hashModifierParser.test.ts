import { describe, it, expect } from 'vitest';
import {
  parseModifierChain,
  parseModifierChainWithError,
  parseShapeOp,
  parseSymbolAnchor,
  parseLineRanges,
  parseLineRangesWithError,
  findShapeSeparator,
} from './hashModifierParser';

// ---------------------------------------------------------------------------
// parseShapeOp
// ---------------------------------------------------------------------------

describe('parseShapeOp', () => {
  it('parses keyword shapes', () => {
    expect(parseShapeOp('sig')).toBe('sig');
    expect(parseShapeOp('fold')).toBe('fold');
    expect(parseShapeOp('dedent')).toBe('dedent');
    expect(parseShapeOp('nocomment')).toBe('nocomment');
    expect(parseShapeOp('imports')).toBe('imports');
    expect(parseShapeOp('exports')).toBe('exports');
  });

  it('parses head(N)', () => {
    expect(parseShapeOp('head(10)')).toEqual({ head: 10 });
    expect(parseShapeOp('head(1)')).toEqual({ head: 1 });
    expect(parseShapeOp('head(999)')).toEqual({ head: 999 });
  });

  it('parses tail(N)', () => {
    expect(parseShapeOp('tail(5)')).toEqual({ tail: 5 });
    expect(parseShapeOp('tail(20)')).toEqual({ tail: 20 });
  });

  it('parses grep(pattern)', () => {
    expect(parseShapeOp('grep(TODO)')).toEqual({ grep: 'TODO' });
    expect(parseShapeOp('grep(export function)')).toEqual({ grep: 'export function' });
  });

  it('parses ex(ranges) — exclude', () => {
    expect(parseShapeOp('ex(30-40)')).toEqual({ exclude: [[30, 40]] });
    expect(parseShapeOp('ex(10-20,30-40)')).toEqual({ exclude: [[10, 20], [30, 40]] });
  });

  it('parses hl(ranges) — highlight', () => {
    expect(parseShapeOp('hl(22)')).toEqual({ highlight: [[22, 22]] });
    expect(parseShapeOp('hl(22,25-27)')).toEqual({ highlight: [[22, 22], [25, 27]] });
  });

  it('parses concept(name)', () => {
    expect(parseShapeOp('concept(error-handling)')).toEqual({ concept: 'error-handling' });
  });

  it('parses pattern(name)', () => {
    expect(parseShapeOp('pattern(singleton)')).toEqual({ pattern: 'singleton' });
  });

  it('parses if(expr)', () => {
    expect(parseShapeOp('if(has_tests)')).toEqual({ if: 'has_tests' });
  });

  it('returns null for invalid shapes', () => {
    expect(parseShapeOp('notashape')).toBeNull();
    expect(parseShapeOp('head()')).toBeNull();
    expect(parseShapeOp('head(abc)')).toBeNull();
    expect(parseShapeOp('')).toBeNull();
    expect(parseShapeOp('grep()')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseLineRanges
// ---------------------------------------------------------------------------

describe('parseLineRanges', () => {
  it('parses single line', () => {
    expect(parseLineRanges('42')).toEqual([[42, 42]]);
  });

  it('parses single range', () => {
    expect(parseLineRanges('10-20')).toEqual([[10, 20]]);
  });

  it('parses multiple ranges', () => {
    expect(parseLineRanges('10-20,30-40')).toEqual([[10, 20], [30, 40]]);
  });

  it('parses mixed lines and ranges', () => {
    expect(parseLineRanges('5,10-20,30')).toEqual([[5, 5], [10, 20], [30, 30]]);
  });

  it('parses open-ended range (start-)', () => {
    expect(parseLineRanges('50-')).toEqual([[50, null]]);
  });

  it('handles whitespace in parts', () => {
    // parseInt handles leading whitespace, so '10 - 20' still parses
    expect(parseLineRanges('10 - 20')).toEqual([[10, 20]]);
    expect(parseLineRanges(' 10-20 , 30-40 ')).toEqual([[10, 20], [30, 40]]);
  });

  it('returns null for non-numeric input', () => {
    expect(parseLineRanges('abc')).toBeNull();
    expect(parseLineRanges('abc-def')).toBeNull();
    expect(parseLineRanges('10-abc')).toBeNull();
    expect(parseLineRanges('')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseLineRanges('')).toBeNull();
  });

  // P1.1: strict validation — line numbers are 1-based and ranges must be ordered.
  describe('strict validation', () => {
    it('rejects inverted ranges', () => {
      expect(parseLineRanges('100-50')).toBeNull();
      expect(parseLineRanges('10-5')).toBeNull();
      expect(parseLineRangesWithError('10-5')).toEqual({ ok: false, reason: 'inverted_range' });
    });

    it('rejects zero / negative start', () => {
      expect(parseLineRanges('0')).toBeNull();
      expect(parseLineRanges('0-5')).toBeNull();
      expect(parseLineRanges('-3-7')).toBeNull();
      expect(parseLineRanges('-5')).toBeNull();
    });

    it('rejects negative end', () => {
      expect(parseLineRanges('5--3')).toBeNull();
    });

    it('still accepts open-ended range (start-)', () => {
      expect(parseLineRanges('50-')).toEqual([[50, null]]);
    });

    it('still accepts equal start/end', () => {
      expect(parseLineRanges('42-42')).toEqual([[42, 42]]);
    });

    it('rejects a whole multi-part list when any part is invalid', () => {
      expect(parseLineRanges('10-20,100-50')).toBeNull();
      expect(parseLineRanges('10-20,0-5')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// findShapeSeparator
// ---------------------------------------------------------------------------

describe('findShapeSeparator', () => {
  it('finds separator between line range and shape', () => {
    expect(findShapeSeparator('15-30:dedent')).toBe(5);
  });

  it('finds separator with comma ranges', () => {
    // '10-20,30-40:sig' — colon is at character index 11
    expect(findShapeSeparator('10-20,30-40:sig')).toBe(11);
  });

  it('returns null when no valid separator', () => {
    expect(findShapeSeparator('dedent')).toBeNull();
    expect(findShapeSeparator('abc:def')).toBeNull();
  });

  it('ignores colons inside parentheses', () => {
    // fn(name:type) should not split at the colon inside parens
    expect(findShapeSeparator('fn(name:type)')).toBeNull();
  });

  it('returns null for plain line ranges without shape', () => {
    expect(findShapeSeparator('10-20')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSymbolAnchor
// ---------------------------------------------------------------------------

describe('parseSymbolAnchor', () => {
  it('parses fn(name)', () => {
    const result = parseSymbolAnchor('fn(myFunc)');
    expect(result).toEqual({ symbol: { kind: 'fn', name: 'myFunc', shape: undefined } });
  });

  it('parses cls(name)', () => {
    const result = parseSymbolAnchor('cls(MyClass)');
    expect(result).toEqual({ symbol: { kind: 'cls', name: 'MyClass', shape: undefined } });
  });

  it('parses sym(name) — no canonical kind', () => {
    const result = parseSymbolAnchor('sym(MySymbol)');
    expect(result).toEqual({ symbol: { name: 'MySymbol', shape: undefined } });
  });

  it('parses fn(name):sig — with shape suffix', () => {
    const result = parseSymbolAnchor('fn(myFunc):sig');
    expect(result).toEqual({ symbol: { kind: 'fn', name: 'myFunc', shape: 'sig' } });
  });

  it('parses fn(name):head(5) — with complex shape', () => {
    const result = parseSymbolAnchor('fn(myFunc):head(5)');
    expect(result).toEqual({ symbol: { kind: 'fn', name: 'myFunc', shape: { head: 5 } } });
  });

  it('returns null for no closing paren', () => {
    expect(parseSymbolAnchor('fn(myFunc')).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(parseSymbolAnchor('xyz(name)')).toBeNull();
  });

  it('returns null for empty name', () => {
    expect(parseSymbolAnchor('fn()')).toBeNull();
  });

  it('returns null when anchor name is only whitespace', () => {
    expect(parseSymbolAnchor('fn(   )')).toBeNull();
  });

  it('returns null for trailing garbage', () => {
    expect(parseSymbolAnchor('fn(name)garbage')).toBeNull();
  });

  it('returns null for invalid shape suffix', () => {
    expect(parseSymbolAnchor('fn(name):notashape')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseModifierChain
// ---------------------------------------------------------------------------

describe('parseModifierChain', () => {
  it('parses keyword modifiers', () => {
    expect(parseModifierChain('source')).toBe('source');
    expect(parseModifierChain('content')).toBe('content');
    expect(parseModifierChain('tokens')).toBe('tokens');
    expect(parseModifierChain('meta')).toBe('meta');
    expect(parseModifierChain('lang')).toBe('lang');
  });

  it('parses shape-only modifiers', () => {
    expect(parseModifierChain('sig')).toEqual({ shape: 'sig' });
    expect(parseModifierChain('fold')).toEqual({ shape: 'fold' });
    expect(parseModifierChain('head(10)')).toEqual({ shape: { head: 10 } });
  });

  it('parses plain line ranges', () => {
    expect(parseModifierChain('15-30')).toEqual({ lines: [[15, 30]] });
    expect(parseModifierChain('10-20,30-40')).toEqual({ lines: [[10, 20], [30, 40]] });
  });

  it('parses line ranges with shape suffix', () => {
    expect(parseModifierChain('15-30:dedent')).toEqual({
      lines: [[15, 30]],
      shape: 'dedent',
    });
    expect(parseModifierChain('10-20,30-40:sig')).toEqual({
      lines: [[10, 20], [30, 40]],
      shape: 'sig',
    });
  });

  it('parses symbol anchors', () => {
    expect(parseModifierChain('fn(myFunc)')).toEqual({
      symbol: { kind: 'fn', name: 'myFunc', shape: undefined },
    });
  });

  it('parses symbol anchors with shape', () => {
    expect(parseModifierChain('fn(myFunc):sig')).toEqual({
      symbol: { kind: 'fn', name: 'myFunc', shape: 'sig' },
    });
  });

  it('returns null for unrecognized input', () => {
    expect(parseModifierChain('notvalid')).toBeNull();
    expect(parseModifierChain('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseModifierChainWithError
// ---------------------------------------------------------------------------

describe('parseModifierChainWithError', () => {
  it('returns ok for valid chains', () => {
    const result = parseModifierChainWithError('sig');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modifier).toEqual({ shape: 'sig' });
    }
  });

  it('returns ok for keyword modifiers', () => {
    const result = parseModifierChainWithError('source');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modifier).toBe('source');
    }
  });

  it('suggests corrections for typos', () => {
    const result = parseModifierChainWithError('sgi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.suggestion).toBe('sig');
      expect(result.reason).toBe('unrecognized modifier chain');
    }
  });

  it('suggests corrections for "imorts"', () => {
    const result = parseModifierChainWithError('imorts');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.suggestion).toBe('imports');
    }
  });

  it('returns no suggestion for completely unknown input', () => {
    const result = parseModifierChainWithError('zzzzzzz');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.suggestion).toBeUndefined();
      expect(result.reason).toBe('unrecognized modifier chain');
    }
  });

  // P1.1: strict range validation surfaces the specific reason so the
  // model can self-correct instead of getting a generic "unrecognized" error.
  it('flags inverted line ranges with a helpful suggestion', () => {
    const result = parseModifierChainWithError('100-50');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/inverted_range/);
      expect(result.suggestion).toMatch(/start <= end/);
    }
  });

  it('flags zero/negative line numbers with a helpful suggestion', () => {
    const zero = parseModifierChainWithError('0-5');
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.reason).toMatch(/non_positive_start/);
      expect(zero.suggestion).toMatch(/1-based/);
    }

    const neg = parseModifierChainWithError('-3-7');
    expect(neg.ok).toBe(false);
    if (!neg.ok) {
      expect(neg.reason).toMatch(/non_positive_start/);
    }
  });

  it('flags invalid ranges inside a shape suffix chain', () => {
    const result = parseModifierChainWithError('100-50:dedent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/inverted_range/);
    }
  });
});

// ---------------------------------------------------------------------------
// findShapeSeparator — compat guard: rejects chains with invalid line ranges.
// ---------------------------------------------------------------------------

describe('findShapeSeparator — strict range compat', () => {
  it('does not find a separator when the line-range part is invalid', () => {
    expect(findShapeSeparator('0-5:sig')).toBeNull();
    expect(findShapeSeparator('100-50:sig')).toBeNull();
  });

  it('still finds the separator for valid line-range chains', () => {
    expect(findShapeSeparator('15-30:dedent')).toBe(5);
    expect(findShapeSeparator('10-20,30-40:sig')).toBe(11);
  });
});
