/**
 * UHPP Phase 6: Shorthand Parser, Compiler, and Helpers — Tests
 */
import { describe, it, expect } from 'vitest';
import {
  parseShorthand,
  compileShorthand,
  parseAndCompile,
  isValidShorthand,
  getShorthandKind,
  generateShorthandReference,
  listShorthandOps,
  getHashAlgorithm,
  DEFAULT_HASH_STRATIFICATION,
} from './uhppShorthand';
import type { ShorthandOp } from './uhppCanonical';

// ---------------------------------------------------------------------------
// parseShorthand — target
// ---------------------------------------------------------------------------

describe('parseShorthand: target', () => {
  it('parses target(h:abc)', () => {
    const r = parseShorthand('target(h:abc)');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'target', ref: 'h:abc' });
    expect(r.raw_input).toBe('target(h:abc)');
  });

  it('fails on empty args', () => {
    const r = parseShorthand('target()');
    expect(r.success).toBe(false);
    expect(r.error?.message).toContain('requires a ref');
  });
});

// ---------------------------------------------------------------------------
// parseShorthand — hydrate
// ---------------------------------------------------------------------------

describe('parseShorthand: hydrate', () => {
  it('parses hydrate(digest, h:abc)', () => {
    const r = parseShorthand('hydrate(digest, h:abc)');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'hydrate', mode: 'digest', ref: 'h:abc' });
  });

  it('parses hydrate(edit_ready_digest, h:xyz)', () => {
    const r = parseShorthand('hydrate(edit_ready_digest, h:xyz)');
    expect(r.success).toBe(true);
    expect(r.op?.kind).toBe('hydrate');
    if (r.op?.kind === 'hydrate') {
      expect(r.op.mode).toBe('edit_ready_digest');
    }
  });

  it('fails on invalid mode', () => {
    const r = parseShorthand('hydrate(invalid_mode, h:abc)');
    expect(r.success).toBe(false);
    expect(r.error?.message).toContain("Invalid hydration mode");
  });

  it('fails with only one arg', () => {
    const r = parseShorthand('hydrate(digest)');
    expect(r.success).toBe(false);
    expect(r.error?.message).toContain('requires mode and ref');
  });
});

// ---------------------------------------------------------------------------
// parseShorthand — neighbors
// ---------------------------------------------------------------------------

describe('parseShorthand: neighbors', () => {
  it('parses neighbors(h:abc, local)', () => {
    const r = parseShorthand('neighbors(h:abc, local)');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'neighbors', ref: 'h:abc', scope: 'local' });
  });

  it('parses neighbors(h:abc, transitive)', () => {
    const r = parseShorthand('neighbors(h:abc, transitive)');
    expect(r.success).toBe(true);
    if (r.op?.kind === 'neighbors') {
      expect(r.op.scope).toBe('transitive');
    }
  });

  it('fails on invalid scope', () => {
    const r = parseShorthand('neighbors(h:abc, wide)');
    expect(r.success).toBe(false);
    expect(r.error?.message).toContain("Invalid scope");
  });

  it('fails with one arg', () => {
    const r = parseShorthand('neighbors(h:abc)');
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseShorthand — diff
// ---------------------------------------------------------------------------

describe('parseShorthand: diff', () => {
  it('parses diff(h:old..h:new)', () => {
    const r = parseShorthand('diff(h:old..h:new)');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'diff', old_ref: 'h:old', new_ref: 'h:new' });
  });

  it('parses diff with two comma-separated args', () => {
    const r = parseShorthand('diff(h:old, h:new)');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'diff', old_ref: 'h:old', new_ref: 'h:new' });
  });

  it('fails with empty args', () => {
    const r = parseShorthand('diff()');
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseShorthand — extract
// ---------------------------------------------------------------------------

describe('parseShorthand: extract', () => {
  it('parses extract(h:big, src/helpers.ts)', () => {
    const r = parseShorthand('extract(h:big, src/helpers.ts)');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'extract', from_ref: 'h:big', into_path: 'src/helpers.ts' });
  });

  it('strips into: prefix', () => {
    const r = parseShorthand('extract(h:big, into:src/helpers.ts)');
    expect(r.success).toBe(true);
    if (r.op?.kind === 'extract') {
      expect(r.op.into_path).toBe('src/helpers.ts');
    }
  });

  it('parses with symbol names', () => {
    const r = parseShorthand('extract(h:big, src/helpers.ts, parseConfig validateInput)');
    expect(r.success).toBe(true);
    if (r.op?.kind === 'extract') {
      expect(r.op.symbol_names).toEqual(['parseConfig', 'validateInput']);
    }
  });

  it('fails with one arg', () => {
    const r = parseShorthand('extract(h:big)');
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseShorthand — rewrite
// ---------------------------------------------------------------------------

describe('parseShorthand: rewrite', () => {
  it('parses rewrite(h:abc, "add error handling")', () => {
    const r = parseShorthand('rewrite(h:abc, "add error handling")');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'rewrite', ref: 'h:abc', intent: 'add error handling' });
  });

  it('handles unquoted intent', () => {
    const r = parseShorthand('rewrite(h:abc, add error handling)');
    expect(r.success).toBe(true);
    if (r.op?.kind === 'rewrite') {
      expect(r.op.intent).toBe('add error handling');
    }
  });

  it('fails with only ref', () => {
    const r = parseShorthand('rewrite(h:abc)');
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseShorthand — verify
// ---------------------------------------------------------------------------

describe('parseShorthand: verify', () => {
  it('parses verify(typecheck, h:abc)', () => {
    const r = parseShorthand('verify(typecheck, h:abc)');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'verify', level: 'typecheck', refs: ['h:abc'] });
  });

  it('parses verify with multiple refs', () => {
    const r = parseShorthand('verify(test, h:abc h:def h:ghi)');
    expect(r.success).toBe(true);
    if (r.op?.kind === 'verify') {
      expect(r.op.refs).toEqual(['h:abc', 'h:def', 'h:ghi']);
    }
  });

  it('fails on invalid level', () => {
    const r = parseShorthand('verify(compile, h:abc)');
    expect(r.success).toBe(false);
    expect(r.error?.message).toContain("Invalid verification level");
  });

  it('fails with no refs', () => {
    const r = parseShorthand('verify(typecheck)');
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseShorthand — session ops (stage, pin, drop)
// ---------------------------------------------------------------------------

describe('parseShorthand: session ops', () => {
  it('parses stage(h:abc)', () => {
    const r = parseShorthand('stage(h:abc)');
    expect(r.success).toBe(true);
    expect(r.op).toEqual({ kind: 'stage', refs: ['h:abc'] });
  });

  it('parses pin(h:abc h:def)', () => {
    const r = parseShorthand('pin(h:abc h:def)');
    expect(r.success).toBe(true);
    if (r.op?.kind === 'pin') {
      expect(r.op.refs).toEqual(['h:abc', 'h:def']);
    }
  });

  it('parses drop with comma-separated args', () => {
    const r = parseShorthand('drop(h:abc, h:def)');
    expect(r.success).toBe(true);
    if (r.op?.kind === 'drop') {
      expect(r.op.refs).toEqual(['h:abc', 'h:def']);
    }
  });

  it('fails on empty refs', () => {
    expect(parseShorthand('stage()').success).toBe(false);
    expect(parseShorthand('pin()').success).toBe(false);
    expect(parseShorthand('drop()').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseShorthand — error handling
// ---------------------------------------------------------------------------

describe('parseShorthand: error handling', () => {
  it('rejects empty input', () => {
    const r = parseShorthand('');
    expect(r.success).toBe(false);
    expect(r.error?.message).toContain('Empty input');
  });

  it('rejects non-function syntax', () => {
    const r = parseShorthand('just a string');
    expect(r.success).toBe(false);
    expect(r.error?.suggestion).toContain('function-call notation');
  });

  it('suggests closest op for typos', () => {
    const r = parseShorthand('targat(h:abc)');
    expect(r.success).toBe(false);
    expect(r.error?.suggestion).toContain("'target'");
  });

  it('suggests for "stag"', () => {
    const r = parseShorthand('stag(h:abc)');
    expect(r.success).toBe(false);
    expect(r.error?.suggestion).toContain("'stage'");
  });

  it('is case-insensitive on op names', () => {
    const r = parseShorthand('TARGET(h:abc)');
    expect(r.success).toBe(true);
    expect(r.op?.kind).toBe('target');
  });

  it('handles whitespace around expression', () => {
    const r = parseShorthand('  target(h:abc)  ');
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compileShorthand
// ---------------------------------------------------------------------------

describe('compileShorthand', () => {
  it('compiles target → read.shaped', () => {
    const r = compileShorthand({ kind: 'target', ref: 'h:abc' });
    expect(r.batch_steps).toHaveLength(1);
    expect(r.batch_steps[0].step_kind).toBe('read.shaped');
    expect(r.batch_steps[0].params).toEqual({ ref: 'h:abc', modifier: 'auto' });
    expect(r.warnings).toHaveLength(0);
  });

  it('compiles hydrate → read.shaped with hydration_mode', () => {
    const r = compileShorthand({ kind: 'hydrate', mode: 'digest', ref: 'h:abc' });
    expect(r.batch_steps[0].step_kind).toBe('read.shaped');
    expect(r.batch_steps[0].params).toEqual({ ref: 'h:abc', hydration_mode: 'digest' });
  });

  it('compiles neighbors → analyze.deps', () => {
    const r = compileShorthand({ kind: 'neighbors', ref: 'h:abc', scope: 'local' });
    expect(r.batch_steps[0].step_kind).toBe('analyze.deps');
    expect(r.batch_steps[0].params).toEqual({ ref: 'h:abc', expansion: 'local' });
  });

  it('compiles diff → read.shaped with diff_ref', () => {
    const r = compileShorthand({ kind: 'diff', old_ref: 'h:old', new_ref: 'h:new' });
    expect(r.batch_steps[0].params).toEqual({ diff_ref: 'h:old..h:new' });
  });

  it('compiles extract → change.refactor', () => {
    const r = compileShorthand({
      kind: 'extract',
      from_ref: 'h:big',
      into_path: 'src/helpers.ts',
      symbol_names: ['parseConfig'],
    });
    expect(r.batch_steps[0].step_kind).toBe('change.refactor');
    expect(r.batch_steps[0].params).toMatchObject({
      action: 'execute',
      operation: 'extract',
      source_ref: 'h:big',
      destination_file: 'src/helpers.ts',
      symbol_names: ['parseConfig'],
    });
  });

  it('compiles extract without symbol_names', () => {
    const r = compileShorthand({
      kind: 'extract',
      from_ref: 'h:big',
      into_path: 'out.ts',
    });
    expect(r.batch_steps[0].params).not.toHaveProperty('symbol_names');
  });

  it('warns on extract with >10 symbols', () => {
    const syms = Array.from({ length: 12 }, (_, i) => `sym${i}`);
    const r = compileShorthand({
      kind: 'extract',
      from_ref: 'h:big',
      into_path: 'out.ts',
      symbol_names: syms,
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('>10 symbols');
  });

  it('compiles rewrite → change.edit', () => {
    const r = compileShorthand({ kind: 'rewrite', ref: 'h:abc', intent: 'add logging' });
    expect(r.batch_steps[0].step_kind).toBe('change.edit');
    expect(r.batch_steps[0].params).toEqual({ ref: 'h:abc', intent: 'add logging' });
  });

  it('compiles verify(typecheck) → verify.build', () => {
    const r = compileShorthand({ kind: 'verify', level: 'typecheck', refs: ['h:abc'] });
    expect(r.batch_steps[0].step_kind).toBe('verify.build');
    expect(r.batch_steps[0].params).toEqual({ target_refs: ['h:abc'], level: 'typecheck' });
  });

  it('compiles verify(test) → verify.test', () => {
    const r = compileShorthand({ kind: 'verify', level: 'test', refs: ['h:a', 'h:b'] });
    expect(r.batch_steps[0].step_kind).toBe('verify.test');
  });

  it('compiles verify(parser) → verify.lint', () => {
    const r = compileShorthand({ kind: 'verify', level: 'parser', refs: ['h:x'] });
    expect(r.batch_steps[0].step_kind).toBe('verify.lint');
  });

  it('compiles stage → session.stage', () => {
    const r = compileShorthand({ kind: 'stage', refs: ['h:a', 'h:b'] });
    expect(r.batch_steps[0].step_kind).toBe('session.stage');
    expect(r.batch_steps[0].params).toEqual({ refs: ['h:a', 'h:b'] });
  });

  it('compiles pin → session.pin', () => {
    const r = compileShorthand({ kind: 'pin', refs: ['h:a'] });
    expect(r.batch_steps[0].step_kind).toBe('session.pin');
  });

  it('compiles drop → session.drop', () => {
    const r = compileShorthand({ kind: 'drop', refs: ['h:a'] });
    expect(r.batch_steps[0].step_kind).toBe('session.drop');
  });
});

// ---------------------------------------------------------------------------
// parseAndCompile
// ---------------------------------------------------------------------------

describe('parseAndCompile', () => {
  it('returns compiled result for valid input', () => {
    const r = parseAndCompile('stage(h:abc)');
    expect('compiled' in r).toBe(true);
    if ('compiled' in r) {
      expect(r.compiled.batch_steps[0].step_kind).toBe('session.stage');
    }
  });

  it('returns error for invalid input', () => {
    const r = parseAndCompile('unknown(h:abc)');
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.message).toContain("Unknown operation");
    }
  });
});

// ---------------------------------------------------------------------------
// isValidShorthand / getShorthandKind
// ---------------------------------------------------------------------------

describe('isValidShorthand', () => {
  it('returns true for valid expressions', () => {
    expect(isValidShorthand('target(h:abc)')).toBe(true);
    expect(isValidShorthand('stage(h:abc h:def)')).toBe(true);
    expect(isValidShorthand('verify(test, h:abc)')).toBe(true);
  });

  it('returns false for invalid expressions', () => {
    expect(isValidShorthand('')).toBe(false);
    expect(isValidShorthand('target()')).toBe(false);
    expect(isValidShorthand('unknown(h:abc)')).toBe(false);
  });
});

describe('getShorthandKind', () => {
  it('returns kind for valid expressions', () => {
    expect(getShorthandKind('target(h:abc)')).toBe('target');
    expect(getShorthandKind('verify(test, h:abc)')).toBe('verify');
    expect(getShorthandKind('drop(h:abc)')).toBe('drop');
  });

  it('returns undefined for invalid', () => {
    expect(getShorthandKind('nope(h:abc)')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listShorthandOps
// ---------------------------------------------------------------------------

describe('listShorthandOps', () => {
  it('returns all 10 ops', () => {
    const ops = listShorthandOps();
    expect(ops).toHaveLength(10);
    expect(ops).toContain('target');
    expect(ops).toContain('hydrate');
    expect(ops).toContain('neighbors');
    expect(ops).toContain('diff');
    expect(ops).toContain('extract');
    expect(ops).toContain('rewrite');
    expect(ops).toContain('verify');
    expect(ops).toContain('stage');
    expect(ops).toContain('pin');
    expect(ops).toContain('drop');
  });
});

// ---------------------------------------------------------------------------
// generateShorthandReference
// ---------------------------------------------------------------------------

describe('generateShorthandReference', () => {
  it('produces a non-empty markdown table', () => {
    const ref = generateShorthandReference();
    expect(ref.length).toBeGreaterThan(100);
    expect(ref).toContain('target(ref)');
    expect(ref).toContain('hydrate(mode, ref)');
    expect(ref).toContain('verify(level, refs)');
    expect(ref).toContain('## UHPP Shorthand Operations');
  });
});

// ---------------------------------------------------------------------------
// Hash stratification helpers
// ---------------------------------------------------------------------------

describe('DEFAULT_HASH_STRATIFICATION', () => {
  it('uses fnv1a for runtime and sha256 for persistence', () => {
    expect(DEFAULT_HASH_STRATIFICATION.runtime_identity).toBe('fnv1a_32');
    expect(DEFAULT_HASH_STRATIFICATION.persistence_identity).toBe('sha256');
    expect(DEFAULT_HASH_STRATIFICATION.verification_identity).toBe('sha256');
  });
});

describe('getHashAlgorithm', () => {
  it('returns correct algorithm for each purpose', () => {
    expect(getHashAlgorithm(DEFAULT_HASH_STRATIFICATION, 'runtime')).toBe('fnv1a_32');
    expect(getHashAlgorithm(DEFAULT_HASH_STRATIFICATION, 'persistence')).toBe('sha256');
    expect(getHashAlgorithm(DEFAULT_HASH_STRATIFICATION, 'verification')).toBe('sha256');
  });
});
