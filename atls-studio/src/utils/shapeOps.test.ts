import { describe, expect, it } from 'vitest';
import { applyShape, dedent } from './shapeOps';

describe('applyShape', () => {
  it('applies dedent', () => {
    const s = '  a\n  b';
    expect(applyShape(s, 'dedent')).toBe('a\nb');
  });

  it('leaves pass-through shape kinds as unchanged content', () => {
    const c = 'x';
    for (const sh of ['fold', 'sig', 'nocomment', 'imports', 'exports'] as const) {
      expect(applyShape(c, sh)).toBe(c);
    }
  });

  it('slices by head and tail', () => {
    const c = 'a\nb\nc\nd';
    expect(applyShape(c, { head: 2 })).toBe('a\nb');
    expect(applyShape(c, { tail: 2 })).toBe('c\nd');
  });

  it('returns content for unknown op object', () => {
    const c = 'z';
    expect(applyShape(c, { other: 1 } as unknown as import('./uhppTypes').ShapeOp)).toBe(c);
  });
});

describe('dedent', () => {
  it('returns unchanged when all lines are blank or zero indent', () => {
    expect(dedent('\n  \n')).toBe('\n  \n');
    expect(dedent('a')).toBe('a');
  });

  it('dedents consistently indented lines', () => {
    expect(dedent('  x\n  y')).toBe('x\ny');
  });

});
