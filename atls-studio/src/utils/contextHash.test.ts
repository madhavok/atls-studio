import { describe, expect, it } from 'vitest';
import { estimateTokens, formatChunkTag, parseChunkTag, formatChunkRef, isCompressedRef } from './contextHash';

describe('contextHash chunk tags', () => {
  it('round-trips compound chunk types without a source', () => {
    const tag = formatChunkTag('abc123', 450, 'msg:user');

    expect(parseChunkTag(tag)).toEqual({
      hash: 'abc123',
      tokens: 450,
      type: 'msg:user',
      source: undefined,
    });
  });

  it('round-trips chunk tags with sources', () => {
    const tag = formatChunkTag('def456', 128, 'file', 'src/utils/hash.ts');

    expect(parseChunkTag(tag)).toEqual({
      hash: 'def456',
      tokens: 128,
      type: 'file',
      source: 'src/utils/hash.ts',
    });
  });

  it('parses chunk tags used in working memory / tagged context (formatChunkTag)', () => {
    const tag = formatChunkTag('feed12', 64, 'exec:cmd', 'scripts/build.ps1');

    expect(parseChunkTag(tag)).toEqual({
      hash: 'feed12',
      tokens: 64,
      type: 'exec:cmd',
      source: 'scripts/build.ps1',
    });
  });

  it('round-trips chunk tags with colon-containing sources', () => {
    const tag = formatChunkTag('feed42', 32, 'exec:cmd', 'C:/repo/scripts/build.ps1');

    expect(parseChunkTag(tag)).toEqual({
      hash: 'feed42',
      tokens: 32,
      type: 'exec:cmd',
      source: 'C:/repo/scripts/build.ps1',
    });
  });

  it('parses legacy tk: prefixed tags', () => {
    expect(parseChunkTag('«h:abc123 tk:450 msg:user»')).toEqual({
      hash: 'abc123',
      tokens: 450,
      type: 'msg:user',
      source: undefined,
    });
  });
});

describe('formatChunkRef', () => {
  it('produces compact format without arrow', () => {
    const ref = formatChunkRef('abc123', 1500, undefined, 'read_file:src/api.ts');
    expect(ref).toBe('[h:abc123 1500tk read_file:src/api.ts]');
    expect(ref).not.toContain('->');
  });

  it('is recognized by isCompressedRef', () => {
    const ref = formatChunkRef('abc123', 1500, undefined, 'read_file:src/api.ts');
    expect(isCompressedRef(ref)).toBe(true);
  });
});

describe('isCompressedRef', () => {
  it('matches new compact format', () => {
    expect(isCompressedRef('[h:abc123 1500tk desc]')).toBe(true);
  });

  it('matches legacy arrow format', () => {
    expect(isCompressedRef('[-> h:abc123, 1500tk | desc]')).toBe(true);
  });

  it('rejects non-refs', () => {
    expect(isCompressedRef('some normal text')).toBe(false);
    expect(isCompressedRef('[Rolling Summary]')).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('estimates tokens for plain prose', () => {
    const content = 'This is ordinary prose without much code punctuation. '.repeat(20);
    const estimate = estimateTokens(content);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(content.length / 3);
  });

  it('does not undercount dense plain text without code punctuation', () => {
    const content = 'alpha beta gamma delta epsilon zeta eta theta iota kappa '.repeat(40);
    const estimate = estimateTokens(content);
    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(content.length / 4));
  });
});
