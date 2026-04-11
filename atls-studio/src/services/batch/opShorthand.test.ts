import { describe, expect, it } from 'vitest';
import {
  SHORT_TO_OP,
  OP_TO_SHORT,
  normalizeOperationUse,
  PARAM_SHORT,
  generateShorthandLegend,
} from './opShorthand';
import { ALL_OPERATIONS } from './families';
import type { OperationKind } from './types';

describe('opShorthand registry', () => {
  it('has a shorthand for every OperationKind', () => {
    for (const op of ALL_OPERATIONS) {
      expect(OP_TO_SHORT[op]).toBeDefined();
    }
  });

  it('covers exactly 76 operations', () => {
    expect(Object.keys(SHORT_TO_OP)).toHaveLength(76);
    expect(Object.keys(OP_TO_SHORT)).toHaveLength(76);
  });

  it('has no duplicate short codes', () => {
    const shorts = Object.keys(SHORT_TO_OP);
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it('round-trips: SHORT_TO_OP and OP_TO_SHORT are inverses', () => {
    for (const [short, op] of Object.entries(SHORT_TO_OP)) {
      expect(OP_TO_SHORT[op as OperationKind]).toBe(short);
    }
  });

  it('no short code collides with a canonical op name', () => {
    const canonicalNames = new Set<string>(ALL_OPERATIONS);
    for (const short of Object.keys(SHORT_TO_OP)) {
      expect(canonicalNames.has(short)).toBe(false);
    }
  });
});

describe('normalizeOperationUse', () => {
  it('resolves known short codes to canonical', () => {
    expect(normalizeOperationUse('sc')).toBe('search.code');
    expect(normalizeOperationUse('ce')).toBe('change.edit');
    expect(normalizeOperationUse('vk')).toBe('verify.typecheck');
    expect(normalizeOperationUse('pi')).toBe('session.pin');
    expect(normalizeOperationUse('bw')).toBe('session.bb.write');
  });

  it('resolves 3-char codes', () => {
    expect(normalizeOperationUse('spl')).toBe('session.plan');
    expect(normalizeOperationUse('ust')).toBe('session.unstage');
    expect(normalizeOperationUse('ulo')).toBe('session.unload');
    expect(normalizeOperationUse('dro')).toBe('session.drop');
    expect(normalizeOperationUse('rec')).toBe('session.recall');
    expect(normalizeOperationUse('eng')).toBe('annotate.engram');
    expect(normalizeOperationUse('srv')).toBe('intent.survey');
    expect(normalizeOperationUse('ifr')).toBe('intent.refactor');
  });

  it('passes through canonical names unchanged', () => {
    expect(normalizeOperationUse('search.code')).toBe('search.code');
    expect(normalizeOperationUse('change.edit')).toBe('change.edit');
    expect(normalizeOperationUse('session.bb.write')).toBe('session.bb.write');
  });

  it('passes through unknown strings unchanged', () => {
    expect(normalizeOperationUse('unknown.op')).toBe('unknown.op');
    expect(normalizeOperationUse('zz')).toBe('zz');
  });
});

describe('PARAM_SHORT', () => {
  it('maps expected keys', () => {
    expect(PARAM_SHORT.ps).toBe('file_paths');
    expect(PARAM_SHORT.sn).toBe('symbol_names');
    expect(PARAM_SHORT.qs).toBe('queries');
    expect(PARAM_SHORT.le).toBe('line_edits');
    expect(PARAM_SHORT.sl).toBe('start_line');
    expect(PARAM_SHORT.el).toBe('end_line');
    expect(PARAM_SHORT.sf).toBe('severity_filter');
    expect(PARAM_SHORT.ff).toBe('focus_files');
  });
});

describe('generateShorthandLegend', () => {
  it('produces a non-empty string with Ops and Params lines', () => {
    const legend = generateShorthandLegend();
    expect(legend).toContain('### Short codes');
    expect(legend).toContain('Ops:');
    expect(legend).toContain('sc=search.code');
    expect(legend).toContain('Params:');
    expect(legend).toContain('ps=file_paths');
  });
});
