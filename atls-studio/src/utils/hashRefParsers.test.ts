import { describe, it, expect } from 'vitest';
import {
  parseUhppRef,
  parseHashRef,
  parseDiffRef,
  parseSetRef,
  parseSetExpression,
} from './hashRefParsers';

// ---------------------------------------------------------------------------
// parseHashRef — basic hash references
// ---------------------------------------------------------------------------

describe('parseHashRef', () => {
  it('parses bare hash ref', () => {
    const result = parseHashRef('h:abc123');
    expect(result).toEqual({ hash: 'abc123', modifier: 'auto' });
  });

  it('parses hash with shape modifier', () => {
    const result = parseHashRef('h:abc123:sig');
    expect(result).toEqual({ hash: 'abc123', modifier: { shape: 'sig' } });
  });

  it('parses hash with line range modifier', () => {
    const result = parseHashRef('h:abc123:15-30');
    expect(result).toEqual({ hash: 'abc123', modifier: { lines: [[15, 30]] } });
  });

  it('parses hash with line range + shape', () => {
    const result = parseHashRef('h:abc123:15-30:dedent');
    expect(result).toEqual({
      hash: 'abc123',
      modifier: { lines: [[15, 30]], shape: 'dedent' },
    });
  });

  it('parses hash with symbol anchor', () => {
    const result = parseHashRef('h:abc123:fn(myFunc)');
    expect(result).toEqual({
      hash: 'abc123',
      modifier: { symbol: { kind: 'fn', name: 'myFunc', shape: undefined } },
    });
  });

  it('parses hash with symbol anchor + shape', () => {
    const result = parseHashRef('h:abc123:fn(myFunc):sig');
    expect(result).toEqual({
      hash: 'abc123',
      modifier: { symbol: { kind: 'fn', name: 'myFunc', shape: 'sig' } },
    });
  });

  it('parses hash with keyword modifier', () => {
    expect(parseHashRef('h:abc123:source')).toEqual({ hash: 'abc123', modifier: 'source' });
    expect(parseHashRef('h:abc123:content')).toEqual({ hash: 'abc123', modifier: 'content' });
    expect(parseHashRef('h:abc123:tokens')).toEqual({ hash: 'abc123', modifier: 'tokens' });
    expect(parseHashRef('h:abc123:meta')).toEqual({ hash: 'abc123', modifier: 'meta' });
    expect(parseHashRef('h:abc123:lang')).toEqual({ hash: 'abc123', modifier: 'lang' });
  });

  it('rejects hash shorter than 6 chars', () => {
    expect(parseHashRef('h:abc')).toBeNull();
    expect(parseHashRef('h:ab')).toBeNull();
  });

  it('rejects hash longer than 16 chars', () => {
    expect(parseHashRef('h:12345678901234567')).toBeNull();
  });

  it('rejects non-hex hash', () => {
    expect(parseHashRef('h:abcxyz')).toBeNull();
    expect(parseHashRef('h:ghijkl')).toBeNull();
  });

  it('accepts exactly 6 and 16 char hashes', () => {
    expect(parseHashRef('h:abcdef')).toEqual({ hash: 'abcdef', modifier: 'auto' });
    expect(parseHashRef('h:1234567890abcdef')).toEqual({ hash: '1234567890abcdef', modifier: 'auto' });
  });

  it('rejects invalid modifier chain', () => {
    expect(parseHashRef('h:abc123:notvalid')).toBeNull();
  });

  it('returns null for non h: prefix', () => {
    expect(parseHashRef('abc123')).toBeNull();
    expect(parseHashRef('x:abc123')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseHashRef('')).toBeNull();
  });

  it('handles uppercase hex', () => {
    expect(parseHashRef('h:ABCDEF')).toEqual({ hash: 'ABCDEF', modifier: 'auto' });
    expect(parseHashRef('h:AbCdEf')).toEqual({ hash: 'AbCdEf', modifier: 'auto' });
  });

  it('trims whitespace', () => {
    expect(parseHashRef('  h:abc123  ')).toEqual({ hash: 'abc123', modifier: 'auto' });
  });
});

// ---------------------------------------------------------------------------
// parseDiffRef
// ---------------------------------------------------------------------------

describe('parseDiffRef', () => {
  it('parses diff ref with h: prefixed hashes', () => {
    const result = parseDiffRef('h:abc123..def456');
    expect(result).toEqual({ oldHash: 'abc123', newHash: 'def456' });
  });

  it('parses diff ref with h: on right side', () => {
    const result = parseDiffRef('h:abc123..h:def456');
    expect(result).toEqual({ oldHash: 'abc123', newHash: 'def456' });
  });

  it('returns null for non-hex hashes', () => {
    expect(parseDiffRef('h:abcxyz..def456')).toBeNull();
  });

  it('returns null for too-short hashes', () => {
    expect(parseDiffRef('h:abc..def456')).toBeNull();
  });

  it('returns null for missing separator', () => {
    expect(parseDiffRef('h:abc123def456')).toBeNull();
  });

  it('returns null for empty sides', () => {
    expect(parseDiffRef('h:..def456')).toBeNull();
    expect(parseDiffRef('h:abc123..')).toBeNull();
  });

  it('returns null for non-diff hash ref', () => {
    expect(parseDiffRef('h:abc123')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSetRef — set references
// ---------------------------------------------------------------------------

describe('parseSetRef', () => {
  it('parses @edited', () => {
    const result = parseSetRef('h:@edited');
    expect(result).toEqual({ selector: { kind: 'edited' }, modifier: 'auto' });
  });

  it('parses @all', () => {
    const result = parseSetRef('h:@all');
    expect(result).toEqual({ selector: { kind: 'all' }, modifier: 'auto' });
  });

  it('parses @pinned', () => {
    const result = parseSetRef('h:@pinned');
    expect(result).toEqual({ selector: { kind: 'pinned' }, modifier: 'auto' });
  });

  it('parses @stale', () => {
    const result = parseSetRef('h:@stale');
    expect(result).toEqual({ selector: { kind: 'stale' }, modifier: 'auto' });
  });

  it('parses @dormant', () => {
    const result = parseSetRef('h:@dormant');
    expect(result).toEqual({ selector: { kind: 'dormant' }, modifier: 'auto' });
  });

  it('parses @dematerialized', () => {
    const result = parseSetRef('h:@dematerialized');
    expect(result).toEqual({ selector: { kind: 'dematerialized' }, modifier: 'auto' });
  });

  it('parses @latest', () => {
    const result = parseSetRef('h:@latest');
    expect(result).toEqual({ selector: { kind: 'latest', count: 1 }, modifier: 'auto' });
  });

  it('parses @latest:N', () => {
    const result = parseSetRef('h:@latest:5');
    expect(result).toEqual({ selector: { kind: 'latest', count: 5 }, modifier: 'auto' });
  });

  it('parses @latest:N:modifier', () => {
    const result = parseSetRef('h:@latest:3:sig');
    expect(result).toEqual({
      selector: { kind: 'latest', count: 3 },
      modifier: { shape: 'sig' },
    });
  });

  it('parses @latest with modifier but no count', () => {
    const result = parseSetRef('h:@latest:sig');
    expect(result).toEqual({
      selector: { kind: 'latest', count: 1 },
      modifier: { shape: 'sig' },
    });
  });

  it('rejects @latest:0', () => {
    expect(parseSetRef('h:@latest:0')).toBeNull();
  });

  it('parses @file=pattern', () => {
    const result = parseSetRef('h:@file=*.ts');
    expect(result).toEqual({ selector: { kind: 'file', pattern: '*.ts' }, modifier: 'auto' });
  });

  it('parses @file=pattern:modifier', () => {
    const result = parseSetRef('h:@file=src/*.ts:sig');
    expect(result).toEqual({
      selector: { kind: 'file', pattern: 'src/*.ts' },
      modifier: { shape: 'sig' },
    });
  });

  it('parses @type=chunkType', () => {
    const result = parseSetRef('h:@type=function');
    expect(result).toEqual({ selector: { kind: 'type', chunkType: 'function' }, modifier: 'auto' });
  });

  it('parses @sub:id', () => {
    const result = parseSetRef('h:@sub:task1');
    expect(result).toEqual({ selector: { kind: 'subtask', id: 'task1' }, modifier: 'auto' });
  });

  it('parses @ws:name', () => {
    const result = parseSetRef('h:@ws:frontend');
    expect(result).toEqual({ selector: { kind: 'workspace', name: 'frontend' }, modifier: 'auto' });
  });

  it('parses @search(query)', () => {
    const result = parseSetRef('h:@search(authentication)');
    expect(result).toEqual({
      selector: { kind: 'search', query: 'authentication' },
      modifier: 'auto',
    });
  });

  it('parses @search(query, limit=N)', () => {
    const result = parseSetRef('h:@search(auth, limit=5)');
    expect(result).toEqual({
      selector: { kind: 'search', query: 'auth', limit: 5 },
      modifier: 'auto',
    });
  });

  it('parses @search(query, tier=high)', () => {
    const result = parseSetRef('h:@search(auth, tier=high)');
    expect(result).toEqual({
      selector: { kind: 'search', query: 'auth', tier: 'high' },
      modifier: 'auto',
    });
  });

  it('rejects @search with empty query', () => {
    expect(parseSetRef('h:@search()')).toBeNull();
  });

  it('rejects @search with invalid option', () => {
    expect(parseSetRef('h:@search(auth, badopt=val)')).toBeNull();
  });

  it('parses @HEAD:path', () => {
    const result = parseSetRef('h:@HEAD:src/main.ts');
    expect(result).toEqual({
      selector: { kind: 'head', path: 'src/main.ts' },
      modifier: 'auto',
    });
  });

  it('parses @HEAD~N:path', () => {
    const result = parseSetRef('h:@HEAD~2:src/main.ts');
    expect(result).toEqual({
      selector: { kind: 'head', path: 'src/main.ts', offset: 2 },
      modifier: 'auto',
    });
  });

  it('parses @HEAD:path:modifier', () => {
    const result = parseSetRef('h:@HEAD:src/main.ts:sig');
    expect(result).toEqual({
      selector: { kind: 'head', path: 'src/main.ts' },
      modifier: { shape: 'sig' },
    });
  });

  it('parses @tag:name:path', () => {
    const result = parseSetRef('h:@tag:v1.0:src/main.ts');
    expect(result).toEqual({
      selector: { kind: 'tag', name: 'v1.0', path: 'src/main.ts' },
      modifier: 'auto',
    });
  });

  it('parses @commit:sha:path', () => {
    const result = parseSetRef('h:@commit:abc123:src/main.ts');
    expect(result).toEqual({
      selector: { kind: 'commit', sha: 'abc123', path: 'src/main.ts' },
      modifier: 'auto',
    });
  });

  it('returns null for empty set ref', () => {
    expect(parseSetRef('h:@')).toBeNull();
  });

  it('returns null for non-set input', () => {
    expect(parseSetRef('h:abc123')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSetExpression — composite set refs
// ---------------------------------------------------------------------------

describe('parseSetExpression', () => {
  it('parses union: @edited+@pinned', () => {
    const result = parseSetExpression('h:@edited+@pinned');
    expect(result).not.toBeNull();
    if (result && 'op' in result) {
      expect(result.op).toBe('+');
      expect(result.left).toEqual({ kind: 'edited' });
      expect(result.right).toEqual({ kind: 'pinned' });
    }
  });

  it('parses intersection: @edited&@pinned', () => {
    const result = parseSetExpression('h:@edited&@pinned');
    expect(result).not.toBeNull();
    if (result && 'op' in result) {
      expect(result.op).toBe('&');
    }
  });

  it('parses difference: @all-@stale', () => {
    const result = parseSetExpression('h:@all-@stale');
    expect(result).not.toBeNull();
    if (result && 'op' in result) {
      expect(result.op).toBe('-');
      expect(result.left).toEqual({ kind: 'all' });
      expect(result.right).toEqual({ kind: 'stale' });
    }
  });

  it('parses single set ref as non-composite', () => {
    const result = parseSetExpression('h:@edited');
    expect(result).not.toBeNull();
    // Single set ref should not have 'op'
    if (result && 'selector' in result) {
      expect(result.selector).toEqual({ kind: 'edited' });
    }
  });

  it('handles whitespace around union operator: @edited + h:@pinned', () => {
    const result = parseSetExpression('h:@edited + h:@pinned');
    expect(result).not.toBeNull();
    if (result && 'op' in result) {
      expect(result.op).toBe('+');
      expect(result.left).toEqual({ kind: 'edited' });
      expect(result.right).toEqual({ kind: 'pinned' });
    }
  });

  it('handles whitespace around operator: @edited & @all', () => {
    const result = parseSetExpression('h:@edited & @all');
    expect(result).not.toBeNull();
    if (result && 'op' in result) {
      expect(result.op).toBe('&');
      expect(result.left).toEqual({ kind: 'edited' });
      expect(result.right).toEqual({ kind: 'all' });
    }
  });

  it('handles whitespace around operator: @all - @stale', () => {
    const result = parseSetExpression('h:@all - @stale');
    expect(result).not.toBeNull();
    if (result && 'op' in result) {
      expect(result.op).toBe('-');
      expect(result.left).toEqual({ kind: 'all' });
      expect(result.right).toEqual({ kind: 'stale' });
    }
  });
});

// ---------------------------------------------------------------------------
// parseUhppRef — unified entry point
// ---------------------------------------------------------------------------

describe('parseUhppRef', () => {
  it('classifies hash refs', () => {
    const result = parseUhppRef('h:abc123');
    expect(result?.kind).toBe('hash');
  });

  it('classifies diff refs', () => {
    const result = parseUhppRef('h:abc123..def456');
    expect(result?.kind).toBe('diff');
  });

  it('classifies set refs', () => {
    const result = parseUhppRef('h:@edited');
    expect(result?.kind).toBe('set');
  });

  it('classifies blackboard refs', () => {
    const result = parseUhppRef('h:bb:mykey');
    expect(result?.kind).toBe('blackboard');
    if (result?.kind === 'blackboard') {
      expect(result.value.key).toBe('mykey');
    }
  });

  it('classifies blackboard refs with modifier', () => {
    const result = parseUhppRef('h:bb:mykey:sig');
    expect(result?.kind).toBe('blackboard');
    if (result?.kind === 'blackboard') {
      expect(result.value.key).toBe('mykey');
      expect(result.value.modifier).toEqual({ shape: 'sig' });
    }
  });

  it('classifies recency refs', () => {
    const result = parseUhppRef('h:$last');
    expect(result?.kind).toBe('recency');
    if (result?.kind === 'recency') {
      expect(result.value.value).toBe('$last');
    }
  });

  it('classifies recency refs with offset', () => {
    const result = parseUhppRef('h:$last-3');
    expect(result?.kind).toBe('recency');
    if (result?.kind === 'recency') {
      expect(result.value.value).toBe('$last-3');
    }
  });

  it('classifies $last_edit', () => {
    const result = parseUhppRef('h:$last_edit');
    expect(result?.kind).toBe('recency');
  });

  it('classifies $last_read', () => {
    const result = parseUhppRef('h:$last_read');
    expect(result?.kind).toBe('recency');
  });

  it('classifies $last_stage', () => {
    const result = parseUhppRef('h:$last_stage');
    expect(result?.kind).toBe('recency');
  });

  it('classifies $last_edit-N', () => {
    const result = parseUhppRef('h:$last_edit-2');
    expect(result?.kind).toBe('recency');
    if (result?.kind === 'recency') {
      expect(result.value.value).toBe('$last-2');
    }
  });

  it('returns null for non h: prefix', () => {
    expect(parseUhppRef('abc123')).toBeNull();
  });

  it('returns null for empty h:', () => {
    expect(parseUhppRef('h:')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseUhppRef('')).toBeNull();
  });

  it('returns null for completely invalid input', () => {
    expect(parseUhppRef('h:$invalid')).toBeNull();
  });
});
