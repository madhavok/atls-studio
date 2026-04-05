/**
 * HPP — Hash reference parser and resolver tests.
 */
import { describe, it, expect } from 'vitest';
import { parseHashRef } from './hashRefParsers';
import { parseModifierChainWithError } from './hashModifierParser';
import {
  parseDiffRef,
  parseSetRef,
  HREF_PATTERN,
  SET_REF_PATTERN,
  matchesSetRefString,
  type HashLookup,
} from './hashResolver';

describe('parseHashRef', () => {
  it('parses simple h:ref', () => {
    const r = parseHashRef('h:abc12345');
    expect(r).not.toBeNull();
    expect(r!.hash).toBe('abc12345');
    expect(r!.modifier).toBe('auto');
  });

  it('parses h:ref with source modifier', () => {
    const r = parseHashRef('h:abc12345:source');
    expect(r).not.toBeNull();
    expect(r!.hash).toBe('abc12345');
    expect(r!.modifier).toBe('source');
  });

  it('parses h:ref with content modifier', () => {
    const r = parseHashRef('h:abc12345:content');
    expect(r).not.toBeNull();
    expect(r!.modifier).toBe('content');
  });

  it('parses h:ref with line range', () => {
    const r = parseHashRef('h:abc12345:15-22');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ lines: [[15, 22]] });
  });

  it('parses h:ref with sig shape', () => {
    const r = parseHashRef('h:abc12345:sig');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ shape: 'sig' });
  });

  it('parses h:ref with fn anchor', () => {
    const r = parseHashRef('h:abc12345:fn(authenticate)');
    expect(r).not.toBeNull();
    expect(r!.modifier).toMatchObject({
      symbol: { kind: 'fn', name: 'authenticate' },
    });
  });

  it('parses ctor anchor (Rust UHPP parity)', () => {
    const r = parseHashRef('h:abc12345:ctor(init)');
    expect(r).not.toBeNull();
    expect(r!.modifier).toMatchObject({
      symbol: { kind: 'ctor', name: 'init' },
    });
  });

  it('returns null for non-h:ref', () => {
    expect(parseHashRef('plain text')).toBeNull();
    expect(parseHashRef('h:')).toBeNull();
    expect(parseHashRef('h:12345')).toBeNull(); // too short
  });
});

describe('parseDiffRef', () => {
  it('parses h:OLD..h:NEW', () => {
    const r = parseDiffRef('h:abc12345..h:def67890');
    expect(r).not.toBeNull();
    expect(r!.oldHash).toBe('abc12345');
    expect(r!.newHash).toBe('def67890');
  });

  it('parses h:OLD..NEW (no h: on second)', () => {
    const r = parseDiffRef('h:abc12345..def67890');
    expect(r).not.toBeNull();
    expect(r!.oldHash).toBe('abc12345');
    expect(r!.newHash).toBe('def67890');
  });

  it('returns null for non-diff', () => {
    expect(parseDiffRef('h:abc12345')).toBeNull();
  });
});

describe('parseSetRef', () => {
  it('parses h:@latest', () => {
    const r = parseSetRef('h:@latest');
    expect(r).not.toBeNull();
    expect(r).toHaveProperty('selector');
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'latest', count: 1 });
    }
  });

  it('parses h:@latest:3', () => {
    const r = parseSetRef('h:@latest:3');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'latest', count: 3 });
    }
  });

  it('rejects malformed latest selectors', () => {
    expect(parseSetRef('h:@latest:0')).toBeNull();
    expect(parseSetRef('h:@latest:-1')).toBeNull();
    expect(parseSetRef('h:@latest:3tail')).toBeNull();
    expect(parseSetRef('h:@latest:abc:tail(5)')).toBeNull();
  });

  it('parses h:@file selector', () => {
    const r = parseSetRef('h:@file=src/foo.ts');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'file', pattern: 'src/foo.ts' });
    }
  });

  it('parses h:@latest:sig as latest selector with modifier', () => {
    const r = parseSetRef('h:@latest:sig');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'latest', count: 1 });
      expect(r.modifier).toEqual({ shape: 'sig' });
    }
  });

  it('parses h:@search selector with options and modifier', () => {
    const r = parseSetRef('h:@search(auth flow,limit=5,tier=high):sig');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'search', query: 'auth flow', limit: 5, tier: 'high' });
      expect(r.modifier).toEqual({ shape: 'sig' });
    }
  });

  it('rejects malformed h:@search selector options', () => {
    expect(parseSetRef('h:@search()')).toBeNull();
    expect(parseSetRef('h:@search(auth,limit=0)')).toBeNull();
    expect(parseSetRef('h:@search(auth,limit=-1)')).toBeNull();
    expect(parseSetRef('h:@search(auth,limit=abc)')).toMatchObject({ selector: { kind: 'search', query: 'auth' } });
    expect(parseSetRef('h:@search(auth,tier=low)')).toMatchObject({ selector: { kind: 'search', query: 'auth' } });
    expect(parseSetRef('h:@search(auth,unknown=1)')).toBeNull();
  });

  it('rejects malformed latest selector', () => {
    expect(parseSetRef('h:@latest3')).toBeNull();
    expect(parseSetRef('h:@latest:abc:tail(5)')).toBeNull();
  });

  it('parses h:@sub:task-id', () => {
    const r = parseSetRef('h:@sub:auth-refactor');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'subtask', id: 'auth-refactor' });
    }
  });

  it('returns null for non-set-ref', () => {
    expect(parseSetRef('h:abc12345')).toBeNull();
  });

  it('parses tag ref with Windows path and shape modifier (colon scan)', () => {
    const r = parseSetRef('h:@tag:v1.0:C:\\proj\\file.ts:sig');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'tag', name: 'v1.0', path: 'C:\\proj\\file.ts' });
      expect(r.modifier).toEqual({ shape: 'sig' });
    }
  });

  it('parses tag ref with short Windows path and head modifier (drive-letter guard)', () => {
    const r = parseSetRef('h:@tag:v1:C:\\foo:head(5)');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'tag', name: 'v1', path: 'C:\\foo' });
      expect(r.modifier).toEqual({ shape: { head: 5 } });
    }
  });
});

describe('HREF_PATTERN', () => {
  it('matches h:refs in text', () => {
    const text = 'See h:abc12345 for details';
    const matches = text.match(HREF_PATTERN);
    expect(matches).toContain('h:abc12345');
  });

  it('matches h:ref with modifier', () => {
    const text = 'Content: h:abc12345:sig';
    const matches = text.match(HREF_PATTERN);
    expect(matches).toContain('h:abc12345:sig');
  });

  it('matches parser-supported anchor aliases in text', () => {
    const text = 'Alias: h:abc12345:class(AuthService)';
    const matches = text.match(HREF_PATTERN);
    expect(matches).toContain('h:abc12345:class(AuthService)');
  });
});

describe('SET_REF_PATTERN', () => {
  it('matches h:@search selector in text', () => {
    const text = 'Use h:@search(auth flow,limit=5,tier=high):sig for lookup';
    const matches = text.match(SET_REF_PATTERN);
    expect(matches).toContain('h:@search(auth flow,limit=5,tier=high):sig');
  });

  it('matches bare h:@search selector without modifier', () => {
    const text = 'Lookup h:@search(auth flow) before continuing';
    const matches = text.match(SET_REF_PATTERN);
    expect(matches).toContain('h:@search(auth flow)');
  });
});

describe('matchesSetRefString', () => {
  it('returns true for parseable set refs', () => {
    expect(matchesSetRefString('h:@latest')).toBe(true);
    expect(matchesSetRefString('  h:@search(q):sig  ')).toBe(true);
  });

  it('returns false for non-set refs', () => {
    expect(matchesSetRefString('h:abc12345')).toBe(false);
    expect(matchesSetRefString('plain')).toBe(false);
  });
});

describe('parseModifierChainWithError', () => {
  it('suggests sig for sgi typo', () => {
    const r = parseModifierChainWithError('sgi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestion).toBe('sig');
  });
});

describe('resolveHashRefsWithMeta', () => {
  it('resolves h:ref in params via lookup', async () => {
    const { resolveHashRefsWithMeta } = await import('./hashResolver');
    const lookup: HashLookup = async (hash) =>
      hash === 'abc12345' ? { content: 'resolved!' } : null;
    const { params } = await resolveHashRefsWithMeta(
      { content: 'h:abc12345' },
      lookup,
    );
    expect(params).toEqual({ content: 'resolved!' });
  });

  it('resolves from_ref to content, not file path (CONTENT_FIELDS parity)', async () => {
    const { resolveHashRefsWithMeta } = await import('./hashResolver');
    const lookup: HashLookup = async (hash) =>
      hash === 'abc12345'
        ? { content: 'BODY', source: '/x/foo.ts' }
        : null;
    const { params } = await resolveHashRefsWithMeta(
      { from_ref: 'h:abc12345' },
      lookup,
    );
    expect(params).toEqual({ from_ref: 'BODY' });
  });

  it('resolves f field to source path, not content (B6 — f is a file_path alias)', async () => {
    const { resolveHashRefsWithMeta } = await import('./hashResolver');
    const lookup: HashLookup = async (hash) =>
      hash === 'fddcaa12'
        ? { content: 'line1\nline2\nline3', source: 'src/__tests__/bracket-torture.ts' }
        : null;
    const { params } = await resolveHashRefsWithMeta(
      { f: 'h:fddcaa12' },
      lookup,
    );
    expect(params).toEqual({ f: 'src/__tests__/bracket-torture.ts' });
  });

  it('resolves f with line modifier to path:L-M so change.edit can derive edit_target_range', async () => {
    const { resolveHashRefsWithMeta } = await import('./hashResolver');
    const lookup: HashLookup = async (hash) =>
      hash === 'fddcaa12'
        ? { content: 'line1\nline2\nline3\nline4', source: 'src/demo.ts' }
        : null;
    const { params } = await resolveHashRefsWithMeta(
      { f: 'h:fddcaa12:2-3' },
      lookup,
    );
    expect(params).toEqual({ f: 'src/demo.ts:2-3' });
  });

  it('resolves file_path with single-line span to path:N-N', async () => {
    const { resolveHashRefsWithMeta } = await import('./hashResolver');
    const lookup: HashLookup = async (hash) =>
      hash === '450e52'
        ? { content: 'x', source: 'atls-studio/src/__tests__/bracket_stress.ts' }
        : null;
    const { params } = await resolveHashRefsWithMeta(
      { file_path: 'h:450e52:38-38' },
      lookup,
    );
    expect(params).toEqual({ file_path: 'atls-studio/src/__tests__/bracket_stress.ts:38-38' });
  });

  it('resolves open-ended line span to path:N-', async () => {
    const { resolveHashRefsWithMeta } = await import('./hashResolver');
    const lookup: HashLookup = async (hash) =>
      hash === 'abc12345'
        ? { content: 'a\nb\nc', source: 'src/x.ts' }
        : null;
    const { params } = await resolveHashRefsWithMeta(
      { f: 'h:abc12345:5-' },
      lookup,
    );
    expect(params).toEqual({ f: 'src/x.ts:5-' });
  });
});