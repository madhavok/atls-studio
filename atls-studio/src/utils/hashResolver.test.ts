/**

  it('rejects h:@latest without a separator', () => {
    expect(parseSetRef('h:@latest3')).toBeNull();
  });
 * HPP — Hash reference parser and resolver tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseHashRef } from './hashRefParsers';
import {
  parseDiffRef,
  parseSetRef,
  HREF_PATTERN,
  SET_REF_PATTERN,
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
});