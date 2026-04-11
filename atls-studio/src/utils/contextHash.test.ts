import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  formatChunkTag,
  parseChunkTag,
  formatChunkRef,
  isCompressedRef,
  flattenCodeSearchHits,
  extractSearchSummary,
  extractSymbolSummary,
  extractDepsSummary,
  sliceContentByLines,
  generateEditReadyDigest,
  formatShapeRef,
  formatDiffRef,
  hashContentSync,
  generateDigest,
} from './contextHash';


describe('generateEditReadyDigest regex fallback line numbers', () => {
  it('counts newline at match start so symbols are on correct 1-based lines', () => {
    const content = '// comment\nfunction foo(){}\nfunction bar(){}';
    const digest = generateEditReadyDigest(content, 'file', undefined);
    expect(digest).toContain('foo:2');
    expect(digest).toContain('bar:3');
  });

  it('line 1 when declaration starts at BOF', () => {
    expect(generateEditReadyDigest('function foo(){}', 'file', undefined)).toContain('foo:1');
  });
});
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

describe('flattenCodeSearchHits (code_search API shapes)', () => {
  it('extracts hits from nested per-query results (Rust batch_query default)', () => {
    const payload = {
      results: [
        {
          query: 'auth',
          results: [
            { file: 'src/a.ts', line: 10, symbol: 'login' },
            { file: 'src/b.ts', line: 2, symbol: 'x' },
          ],
        },
      ],
    };
    const rows = flattenCodeSearchHits(payload);
    expect(rows.map((r) => r.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(extractSearchSummary(payload, ['auth'])).toContain('2 matches');
  });

  it('extracts compact r[] with f/l keys', () => {
    const payload = {
      results: [{ q: 'x', r: [{ f: 'm.ts', l: 5, k: 'fn', r: 0.9 }] }],
    };
    expect(flattenCodeSearchHits(payload).map((r) => [r.file, r.line])).toEqual([['m.ts', 5]]);
  });

  it('returns [] when outer results are query wrappers without nested hits', () => {
    const payload = { results: [{ query: 'z', results: [] }] };
    expect(flattenCodeSearchHits(payload)).toEqual([]);
  });
});

describe('extractSymbolSummary', () => {
  it('counts results array when present', () => {
    expect(extractSymbolSummary({ results: [{}, {}] }, ['Foo', 'Bar'])).toBe('2 refs for Foo, Bar');
  });

  it('falls back to symbol list when no results', () => {
    expect(extractSymbolSummary({}, ['X'])).toBe('symbols: X');
  });

  it('handles nullish payload', () => {
    expect(extractSymbolSummary(null, ['A', 'B'])).toBe('A, B');
  });
});

describe('extractDepsSummary', () => {
  it('counts results for graph mode', () => {
    expect(extractDepsSummary({ results: [{ f: 1 }] }, ['src/a.ts'], 'graph')).toBe(
      'graph: 1 entries for src/a.ts',
    );
  });

  it('falls back when empty results', () => {
    expect(extractDepsSummary({ results: [] }, ['p1', 'p2'], 'impact')).toBe('deps impact: p1, p2');
  });
});

describe('sliceContentByLines', () => {
  const body = 'aa\nbb\ncc\ndd';

  it('prefixes lines when raw is false', () => {
    expect(sliceContentByLines(body, '2-3', false)).toBe('   2|bb\n   3|cc');
  });

  it('returns raw lines when raw is true', () => {
    expect(sliceContentByLines(body, '2-3', true)).toBe('bb\ncc');
  });

  it('returns empty string for invalid spec', () => {
    expect(sliceContentByLines(body, '0-1', false)).toBe('');
  });

  it('open-ended range runs to EOF', () => {
    expect(sliceContentByLines(body, '3-', true)).toBe('cc\ndd');
  });
});

describe('formatShapeRef and formatDiffRef', () => {
  it('formats shaped hash refs for tool output', () => {
    expect(formatShapeRef('abc123', 'sig', '10-20')).toBe('h:abc123:10-20:sig');
    expect(formatShapeRef('abc123', 'sig')).toBe('h:abc123:sig');
  });

  it('formats diff ref with short hashes', () => {
    expect(formatDiffRef('deadbeef00', 'cafebabe00')).toBe('h:deadbe..cafeba');
  });
});

describe('hashContentSync', () => {
  it('is deterministic for the same string', () => {
    const s = 'const x = 1;\n';
    expect(hashContentSync(s)).toBe(hashContentSync(s));
  });
});

describe('generateDigest', () => {
  it('uses key-line extraction for result chunks', () => {
    const d = generateDigest('hello world', 'result', undefined);
    expect(d).toContain('hello world');
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
