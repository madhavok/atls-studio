/**
 * Hard HPP hash resolver tests — exercises parser edge cases, modifier chains,
 * set-ref composition, inline resolution, and the full resolve pipeline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseHashRef } from './hashRefParsers';
import {
  parseDiffRef, parseSetRef,
  HREF_PATTERN, BB_REF_PATTERN, SET_REF_PATTERN,
  resolveHashRefsWithMeta,
  resolveHashRefsInParams,
  resolveCompositeSetRef,
  resolveSetRefToValues,
  isTemporalSelector,
  setRecencyResolver,
  setEditRecencyResolver,
  resolveRecencyInString,
  type HashLookup,
  type SetRefLookup,
  type SetSelector,
  type SetRefResult,
  type CompositeSetRef,
  type ParsedSetRef,
} from './hashResolver';

// ── Parser edge cases ──

describe('parseHashRef edge cases', () => {
  it('6-char hash (minimum)', () => {
    const r = parseHashRef('h:abcdef');
    expect(r).not.toBeNull();
    expect(r!.hash).toBe('abcdef');
  });

  it('16-char hash (maximum)', () => {
    const r = parseHashRef('h:abcdef1234567890');
    expect(r).not.toBeNull();
    expect(r!.hash).toBe('abcdef1234567890');
  });

  it('rejects 5-char hash (too short)', () => {
    expect(parseHashRef('h:abcde')).toBeNull();
  });

  it('rejects 17-char hash (too long)', () => {
    expect(parseHashRef('h:abcdef12345678901')).toBeNull();
  });

  it('rejects non-hex chars', () => {
    expect(parseHashRef('h:ghijklmn')).toBeNull();
    expect(parseHashRef('h:abc$%^12')).toBeNull();
  });

  it('parses all shape modifiers', () => {
    const shapes = ['sig', 'fold', 'dedent', 'nocomment', 'imports', 'exports'];
    for (const shape of shapes) {
      const r = parseHashRef(`h:abc12345:${shape}`);
      expect(r, `should parse :${shape}`).not.toBeNull();
      expect(r!.modifier).toEqual({ shape });
    }
  });

  it('parses head/tail with argument', () => {
    const h = parseHashRef('h:abc12345:head(20)');
    expect(h).not.toBeNull();
    expect(h!.modifier).toEqual({ shape: { head: 20 } });

    const t = parseHashRef('h:abc12345:tail(50)');
    expect(t).not.toBeNull();
    expect(t!.modifier).toEqual({ shape: { tail: 50 } });
  });

  it('parses grep modifier', () => {
    const r = parseHashRef('h:abc12345:grep(async function)');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ shape: { grep: 'async function' } });
  });

  it('parses line range with shape', () => {
    const r = parseHashRef('h:abc12345:15-30:dedent');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ lines: [[15, 30]], shape: 'dedent' });
  });

  it('parses multi-range', () => {
    const r = parseHashRef('h:abc12345:1-5,10-20');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ lines: [[1, 5], [10, 20]] });
  });

  it('parses open-ended range', () => {
    const r = parseHashRef('h:abc12345:50-');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ lines: [[50, null]] });
  });

  it('parses symbol anchors with shapes', () => {
    const r = parseHashRef('h:abc12345:fn(authenticate):sig');
    expect(r).not.toBeNull();
    // Shape inside symbol anchor is the raw ShapeOp string, not nested object
    expect(r!.modifier).toMatchObject({
      symbol: { kind: 'fn', name: 'authenticate', shape: 'sig' },
    });
  });

  it('parses cls anchor', () => {
    const r = parseHashRef('h:abc12345:cls(AuthService)');
    expect(r).not.toBeNull();
    expect(r!.modifier).toMatchObject({
      symbol: { kind: 'cls', name: 'AuthService' },
    });
  });

  it('parses meta modifiers', () => {
    expect(parseHashRef('h:abc12345:tokens')!.modifier).toBe('tokens');
    expect(parseHashRef('h:abc12345:meta')!.modifier).toBe('meta');
    expect(parseHashRef('h:abc12345:lang')!.modifier).toBe('lang');
  });

  it('parses concept modifier', () => {
    const r = parseHashRef('h:abc12345:concept(authentication)');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ shape: { concept: 'authentication' } });
  });

  it('parses pattern modifier', () => {
    const r = parseHashRef('h:abc12345:pattern(error-handling)');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ shape: { pattern: 'error-handling' } });
  });

  it('parses if modifier', () => {
    const r = parseHashRef('h:abc12345:if(has(TODO))');
    expect(r).not.toBeNull();
    expect(r!.modifier).toEqual({ shape: { if: 'has(TODO)' } });
  });
});

// ── Diff refs ──

describe('parseDiffRef edge cases', () => {
  it('both prefixed', () => {
    const r = parseDiffRef('h:aabb1122..h:ccdd3344');
    expect(r).toEqual({ oldHash: 'aabb1122', newHash: 'ccdd3344' });
  });

  it('rejects single hash', () => {
    expect(parseDiffRef('h:aabb1122')).toBeNull();
  });

  it('rejects non-h: start', () => {
    expect(parseDiffRef('aabb1122..ccdd3344')).toBeNull();
  });
});

// ── Set-ref parsing ──

describe('parseSetRef comprehensive', () => {
  it('h:@all', () => {
    const r = parseSetRef('h:@all');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) expect(r.selector).toEqual({ kind: 'all' });
  });

  it('h:@edited', () => {
    const r = parseSetRef('h:@edited');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) expect(r.selector).toEqual({ kind: 'edited' });
  });

  it('h:@pinned', () => {
    const r = parseSetRef('h:@pinned');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) expect(r.selector).toEqual({ kind: 'pinned' });
  });

  it('h:@type=file', () => {
    const r = parseSetRef('h:@type=file');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) expect(r.selector).toEqual({ kind: 'type', chunkType: 'file' });
  });

  it('h:@sub with modifier', () => {
    const r = parseSetRef('h:@sub:auth-task:sig');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'subtask', id: 'auth-task' });
      expect(r.modifier).toEqual({ shape: 'sig' });
    }
  });

  it('h:@ws:name', () => {
    const r = parseSetRef('h:@ws:backend');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) expect(r.selector).toEqual({ kind: 'workspace', name: 'backend' });
  });

  it('composite set ref with + operator', () => {
    const r = parseSetRef('h:@sub:auth+h:@sub:db');
    expect(r).not.toBeNull();
    if (r && 'op' in r) {
      expect(r.op).toBe('+');
      expect(r.left).toEqual({ kind: 'subtask', id: 'auth' });
      expect(r.right).toEqual({ kind: 'subtask', id: 'db' });
    }
  });

  it('rejects invalid set-ref', () => {
    expect(parseSetRef('h:abc12345')).toBeNull();
    expect(parseSetRef('h:@')).toBeNull();
    expect(parseSetRef('plain text')).toBeNull();
  });
});

// ── Regex pattern matching ──

describe('HREF_PATTERN matching', () => {
  it('finds multiple refs in text', () => {
    const text = 'Compare h:aabb1122:sig with h:ccdd3344:15-30 and see h:eeff5566';
    const matches = [...text.matchAll(new RegExp(HREF_PATTERN.source, 'g'))].map(m => m[0]);
    expect(matches).toEqual(['h:aabb1122:sig', 'h:ccdd3344:15-30', 'h:eeff5566']);
  });

  it('matches diff ref', () => {
    const text = 'Diff: h:aabb1122..h:ccdd3344';
    const matches = [...text.matchAll(new RegExp(HREF_PATTERN.source, 'g'))].map(m => m[0]);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe('BB_REF_PATTERN matching', () => {
  it('matches blackboard refs', () => {
    const text = 'See h:bb:task-plan and h:bb:refactor.status';
    const matches = [...text.matchAll(new RegExp(BB_REF_PATTERN.source, 'g'))].map(m => m[0]);
    expect(matches).toContain('h:bb:task-plan');
    expect(matches).toContain('h:bb:refactor.status');
  });
});

describe('SET_REF_PATTERN matching', () => {
  it('matches set refs in text', () => {
    const text = 'Load h:@sub:auth-task then h:@latest:3 and h:@edited';
    const matches = [...text.matchAll(new RegExp(SET_REF_PATTERN.source, 'g'))].map(m => m[0]);
    expect(matches).toContain('h:@sub:auth-task');
    expect(matches).toContain('h:@latest:3');
    expect(matches).toContain('h:@edited');
  });
});

// ── Full resolver pipeline ──

describe('resolveHashRefsWithMeta pipeline', () => {
  const mockLookup: HashLookup = async (hash) => {
    const store: Record<string, { content: string; source?: string }> = {
      'aabb1122': { content: 'function foo() { return 1; }', source: 'src/foo.ts' },
      'ccdd3344': { content: 'function bar() { return 2; }', source: 'src/bar.ts' },
      'eeff5566': { content: 'line1\nline2\nline3\nline4\nline5', source: 'src/multi.ts' },
    };
    return store[hash] ?? store[hash.slice(0, 8)] ?? null;
  };

  it('resolves source modifier to file path', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { file: 'h:aabb1122:source' },
      mockLookup,
    );
    expect((params as Record<string, unknown>).file).toBe('src/foo.ts');
  });

  it('resolves content modifier to full content', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { data: 'h:aabb1122:content' },
      mockLookup,
    );
    expect((params as Record<string, unknown>).data).toBe('function foo() { return 1; }');
  });

  it('resolves file field auto-detects to source path', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { file_path: 'h:aabb1122' },
      mockLookup,
    );
    expect((params as Record<string, unknown>).file_path).toBe('src/foo.ts');
  });

  it('resolves nested params', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { outer: { file: 'h:aabb1122:source', content: 'h:ccdd3344:content' } },
      mockLookup,
    );
    const outer = (params as Record<string, Record<string, unknown>>).outer;
    expect(outer.file).toBe('src/foo.ts');
    expect(outer.content).toBe('function bar() { return 2; }');
  });

  it('unresolved hash left as-is', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { file: 'h:deadbeef' },
      mockLookup,
    );
    expect((params as Record<string, unknown>).file).toBe('h:deadbeef');
  });

  it('non-h:ref strings pass through', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { name: 'plain text', count: 42 },
      mockLookup,
    );
    expect(params).toEqual({ name: 'plain text', count: 42 });
  });

  it('array of refs resolved', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { file_paths: ['h:aabb1122:source', 'h:ccdd3344:source'] },
      mockLookup,
    );
    const arr = (params as Record<string, string[]>).file_paths;
    expect(arr).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('file_paths h:ref with auto modifier resolves to source path', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { file_paths: ['h:aabb1122', 'src/other.ts'] },
      mockLookup,
    );
    const arr = (params as Record<string, string[]>).file_paths;
    expect(arr[0]).toBe('src/foo.ts');
    expect(arr[1]).toBe('src/other.ts');
  });

  it('inline refs with modifier in content field resolved', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { content: 'See h:aabb1122:content for details' },
      mockLookup,
    );
    const c = (params as Record<string, string>).content;
    expect(c).toContain('function foo()');
    expect(c).not.toContain('h:aabb1122');
  });

  it('bare h:ref in content field left as literal (no modifier)', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { content: 'See h:aabb1122 for details' },
      mockLookup,
    );
    const c = (params as Record<string, string>).content;
    expect(c).toBe('See h:aabb1122 for details');
  });

  it('line_edits content NOT expanded (literal content array)', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { line_edits: [{ line: 1, action: 'replace', content: 'h:aabb1122 stays literal' }] },
      mockLookup,
    );
    const edits = (params as Record<string, Array<Record<string, string | number>>>).line_edits;
    expect(edits[0].line).toBe(1);
    expect(edits[0].content).toBe('h:aabb1122 stays literal');
  });

  it('preserves numeric fields in nested batch step with (line_edits)', async () => {
    const { params } = await resolveHashRefsWithMeta(
      {
        steps: [
          {
            id: 'e1',
            use: 'change.edit',
            with: {
              file_path: 'src/x.ts',
              line_edits: [{ line: 6, action: 'replace', count: 4, content: 'ok' }],
            },
          },
        ],
      },
      mockLookup,
    );
    const steps = (params as { steps: Array<{ with: { line_edits: Array<{ line: number }> } }> }).steps;
    expect(steps[0].with.line_edits[0].line).toBe(6);
  });

  it('preserves read.lines start_line and end_line numbers', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { file_path: 'src/x.ts', start_line: 9, end_line: 16 },
      mockLookup,
    );
    const p = params as { start_line: number; end_line: number };
    expect(p.start_line).toBe(9);
    expect(p.end_line).toBe(16);
  });

  it('creates[].content expands inline UHPP with modifier (CONTENT-AS-REF)', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { creates: [{ path: 'new.ts', content: 'import { foo } from "./foo";\n\nh:aabb1122:content' }] },
      mockLookup,
    );
    const creates = (params as Record<string, Array<Record<string, string>>>).creates;
    expect(creates[0].content).toContain('function foo()');
    expect(creates[0].content).not.toContain('h:aabb1122');
  });

  it('creates[].content leaves bare h:ref as literal', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { creates: [{ path: 'new.ts', content: '// source: h:aabb1122\nexport const x = 1;' }] },
      mockLookup,
    );
    const creates = (params as Record<string, Array<Record<string, string>>>).creates;
    expect(creates[0].content).toContain('h:aabb1122');
    expect(creates[0].content).toContain('export const x = 1;');
  });
});

// ── resolveHashRefsInParams (without meta) ──

describe('resolveHashRefsInParams', () => {
  const lookup: HashLookup = async (hash) =>
    hash === 'abc12345' ? { content: 'resolved content', source: 'src/resolved.ts' } : null;

  it('resolves and returns params directly', async () => {
    const result = await resolveHashRefsInParams(
      { file: 'h:abc12345:source' },
      lookup,
    );
    expect((result as Record<string, unknown>).file).toBe('src/resolved.ts');
  });

  it('handles null/undefined params', async () => {
    expect(await resolveHashRefsInParams(null, lookup)).toBeNull();
    expect(await resolveHashRefsInParams(undefined, lookup)).toBeUndefined();
  });

  it('handles primitive params', async () => {
    expect(await resolveHashRefsInParams(42, lookup)).toBe(42);
    expect(await resolveHashRefsInParams(true, lookup)).toBe(true);
  });

  it('resolves file_path line span to source path with :L-M suffix', async () => {
    const result = await resolveHashRefsInParams(
      { file_path: 'h:abc12345:10-12' },
      lookup,
    );
    expect((result as Record<string, unknown>).file_path).toBe('src/resolved.ts:10-12');
  });

  it('keeps hash-like metadata fields canonical even with span modifiers', async () => {
    const result = await resolveHashRefsInParams(
      { content_hash: 'h:abc12345:10-12', edit_target_hash: 'h:abc12345:10-12' },
      lookup,
    );
    expect((result as Record<string, unknown>).content_hash).toBe('abc12345');
    expect((result as Record<string, unknown>).edit_target_hash).toBe('abc12345');
  });

  it('passes edit_target_ref through unchanged', async () => {
    const result = await resolveHashRefsInParams(
      { edit_target_ref: 'h:abc12345:10-12' },
      lookup,
    );
    expect((result as Record<string, unknown>).edit_target_ref).toBe('h:abc12345:10-12');
  });

  it('passes batch goal through unchanged when it looks like an h: ref (task text, not UHPP)', async () => {
    const result = await resolveHashRefsInParams(
      { goal: 'h:abc12345:10-12 inspect handler' },
      lookup,
    );
    expect((result as Record<string, unknown>).goal).toBe('h:abc12345:10-12 inspect handler');
  });

  it('does not expand session.plan subtasks strings that start with h: (id:title syntax)', async () => {
    const result = await resolveHashRefsInParams(
      {
        steps: [
          {
            id: 'p1',
            use: 'session.plan',
            with: {
              goal: 'refactor',
              subtasks: ['h:a1b2c3d4e5f6a7b8: Phase one', { id: 'x', title: 'h:abc12345: optional title' }],
            },
          },
        ],
      },
      lookup,
    );
    const steps = (result as { steps: Array<{ with: Record<string, unknown> }> }).steps;
    expect(steps[0].with.subtasks).toEqual([
      'h:a1b2c3d4e5f6a7b8: Phase one',
      { id: 'x', title: 'h:abc12345: optional title' },
    ]);
  });
});

// ── Null content guard ──

describe('null content guard', () => {
  it('leaves ref as-is when lookup returns entry with no content', async () => {
    const nullContentLookup: HashLookup = async (_hash) =>
      ({ content: undefined as unknown as string, source: 'test.ts' });

    const result = await resolveHashRefsInParams(
      { file: 'h:abc12345' },
      nullContentLookup,
    );
    expect((result as Record<string, unknown>).file).toBe('h:abc12345');
  });

  it('leaves ref as-is when lookup returns empty content', async () => {
    const emptyContentLookup: HashLookup = async (_hash) =>
      ({ content: '', source: 'test.ts' });

    const result = await resolveHashRefsInParams(
      { file: 'h:abc12345' },
      emptyContentLookup,
    );
    expect((result as Record<string, unknown>).file).toBe('h:abc12345');
  });

  it('allows source modifier even with no content', async () => {
    const noContentLookup: HashLookup = async (_hash) =>
      ({ content: undefined as unknown as string, source: 'src/valid.ts' });

    const result = await resolveHashRefsInParams(
      { file: 'h:abc12345:source' },
      noContentLookup,
    );
    expect((result as Record<string, unknown>).file).toBe('src/valid.ts');
  });

  it('resolves normally when content is present', async () => {
    const goodLookup: HashLookup = async (_hash) =>
      ({ content: 'function foo() {}', source: 'test.ts' });

    const result = await resolveHashRefsInParams(
      { body: 'h:abc12345' },
      goodLookup,
    );
    expect((result as Record<string, unknown>).body).toBe('function foo() {}');
  });
});

// ── Search selector parsing ──

describe('parseSetRef search selector', () => {
  it('parses h:@search(query) basic', () => {
    const r = parseSetRef('h:@search(authentication)');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'search', query: 'authentication' });
    }
  });

  it('parses h:@search(query,limit=5)', () => {
    const r = parseSetRef('h:@search(auth,limit=5)');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'search', query: 'auth', limit: 5 });
    }
  });

  it('parses h:@search(query,tier=high)', () => {
    const r = parseSetRef('h:@search(auth,tier=high)');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'search', query: 'auth', tier: 'high' });
    }
  });

  it('parses h:@search(query,tier=medium)', () => {
    const r = parseSetRef('h:@search(auth,tier=medium)');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'search', query: 'auth', tier: 'medium' });
    }
  });

  it('parses h:@search with both limit and tier', () => {
    const r = parseSetRef('h:@search(error handling,limit=10,tier=high)');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({
        kind: 'search',
        query: 'error handling',
        limit: 10,
        tier: 'high',
      });
    }
  });

  it('parses h:@search(query):sig with shape modifier', () => {
    const r = parseSetRef('h:@search(auth):sig');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'search', query: 'auth' });
      expect(r.modifier).toEqual({ shape: 'sig' });
    }
  });

  it('rejects h:@search() with empty query', () => {
    const r = parseSetRef('h:@search()');
    expect(r).toBeNull();
  });

  it('rejects h:@search( with unclosed paren', () => {
    const r = parseSetRef('h:@search(auth');
    expect(r).toBeNull();
  });

  it('ignores invalid tier values', () => {
    const r = parseSetRef('h:@search(auth,tier=low)');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'search', query: 'auth' });
    }
  });

  it('ignores invalid limit values', () => {
    const r = parseSetRef('h:@search(auth,limit=abc)');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'search', query: 'auth' });
    }
  });
});

// ── Temporal ref parsing ──

describe('parseSetRef temporal refs', () => {
  it('parses h:@HEAD:path', () => {
    const r = parseSetRef('h:@HEAD:src/main.rs');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'head', path: 'src/main.rs' });
    }
  });

  it('parses h:@HEAD~3:path', () => {
    const r = parseSetRef('h:@HEAD~3:src/main.rs');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'head', path: 'src/main.rs', offset: 3 });
    }
  });

  it('parses h:@tag:v1.0:path', () => {
    const r = parseSetRef('h:@tag:v1.0:src/lib.rs');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'tag', name: 'v1.0', path: 'src/lib.rs' });
    }
  });

  it('parses h:@commit:sha:path', () => {
    const r = parseSetRef('h:@commit:abc123:src/lib.rs');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'commit', sha: 'abc123', path: 'src/lib.rs' });
    }
  });

  it('parses h:@HEAD:path:sig with modifier', () => {
    const r = parseSetRef('h:@HEAD:src/main.rs:sig');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'head', path: 'src/main.rs' });
      expect(r.modifier).toEqual({ shape: 'sig' });
    }
  });

  it('parses h:@tag:release:path:dedent with modifier', () => {
    const r = parseSetRef('h:@tag:release:src/api.ts:dedent');
    expect(r).not.toBeNull();
    if (r && 'selector' in r) {
      expect(r.selector).toEqual({ kind: 'tag', name: 'release', path: 'src/api.ts' });
      expect(r.modifier).toEqual({ shape: 'dedent' });
    }
  });

  it('rejects h:@HEAD without path', () => {
    const r = parseSetRef('h:@HEAD');
    expect(r).toBeNull();
  });

  it('rejects h:@tag without path', () => {
    const r = parseSetRef('h:@tag:v1.0');
    expect(r).toBeNull();
  });

  it('rejects h:@commit without path', () => {
    const r = parseSetRef('h:@commit:abc123');
    expect(r).toBeNull();
  });

  it('isTemporalSelector correctly identifies temporal kinds', () => {
    expect(isTemporalSelector({ kind: 'head', path: 'x' })).toBe(true);
    expect(isTemporalSelector({ kind: 'tag', name: 'v1', path: 'x' })).toBe(true);
    expect(isTemporalSelector({ kind: 'commit', sha: 'abc', path: 'x' })).toBe(true);
    expect(isTemporalSelector({ kind: 'all' })).toBe(false);
    expect(isTemporalSelector({ kind: 'edited' })).toBe(false);
    expect(isTemporalSelector({ kind: 'search', query: 'test' })).toBe(false);
  });
});

// ── Recency ref resolution ──

describe('recency ref resolution', () => {
  beforeEach(() => {
    setRecencyResolver(null as unknown as (offset: number) => string | null);
    setEditRecencyResolver(null as unknown as (offset: number) => string | null);
  });

  it('resolves h:$last to most recent hash via resolveHashRefsInParams', async () => {
    const recencyStack = ['aabb1122', 'ccdd3344', 'eeff5566'];
    setRecencyResolver((offset) => offset < recencyStack.length ? recencyStack[offset] : null);

    const lookup: HashLookup = async (hash) =>
      hash === 'aabb1122' ? { content: 'latest content', source: 'src/latest.ts' } : null;

    const result = await resolveHashRefsInParams(
      { file: 'h:aabb1122:source' },
      lookup,
    );
    expect((result as Record<string, unknown>).file).toBe('src/latest.ts');
  });

  it('resolves h:$last-1 to second most recent hash', async () => {
    const recencyStack = ['aabb1122', 'ccdd3344', 'eeff5566'];
    setRecencyResolver((offset) => offset < recencyStack.length ? recencyStack[offset] : null);

    const lookup: HashLookup = async (hash) => {
      if (hash === 'ccdd3344') return { content: 'second content', source: 'src/second.ts' };
      return null;
    };

    const result = await resolveHashRefsInParams(
      { body: 'h:$last-1' },
      lookup,
    );
    expect((result as Record<string, unknown>).body).toBe('second content');
  });

  it('resolves h:$last_edit to most recent edit hash', async () => {
    const editStack = ['aabb0011', 'ccdd0022'];
    setEditRecencyResolver((offset) => offset < editStack.length ? editStack[offset] : null);

    const lookup: HashLookup = async (hash) =>
      hash === 'aabb0011' ? { content: 'edited content', source: 'src/edited.ts' } : null;

    const result = await resolveHashRefsInParams(
      { body: 'h:$last_edit' },
      lookup,
    );
    expect((result as Record<string, unknown>).body).toBe('edited content');
  });

  it('resolves h:$last_edit-1 to previous edit hash', async () => {
    const editStack = ['aabb0011', 'ccdd0022'];
    setEditRecencyResolver((offset) => offset < editStack.length ? editStack[offset] : null);

    const lookup: HashLookup = async (hash) =>
      hash === 'ccdd0022' ? { content: 'prev edit', source: 'src/prev.ts' } : null;

    const result = await resolveHashRefsInParams(
      { body: 'h:$last_edit-1' },
      lookup,
    );
    expect((result as Record<string, unknown>).body).toBe('prev edit');
  });

  it('leaves h:$last unresolved when no resolver set', async () => {
    const lookup: HashLookup = async () => null;
    const result = await resolveHashRefsInParams(
      { body: 'h:$last' },
      lookup,
    );
    expect((result as Record<string, unknown>).body).toBe('h:$last');
  });

  it('leaves h:$last_edit unresolved when no resolver set', async () => {
    const lookup: HashLookup = async () => null;
    const result = await resolveHashRefsInParams(
      { body: 'h:$last_edit' },
      lookup,
    );
    expect((result as Record<string, unknown>).body).toBe('h:$last_edit');
  });

  it('leaves h:$last-N unresolved when offset exceeds stack', async () => {
    setRecencyResolver((offset) => offset < 1 ? 'aabb1122' : null);

    const lookup: HashLookup = async () => null;
    const result = await resolveHashRefsInParams(
      { body: 'h:$last-5' },
      lookup,
    );
    expect((result as Record<string, unknown>).body).toBe('h:$last-5');
  });

  it('undo: "h:$last" routes to the EDIT recency stack (not the generic one)', () => {
    // The generic stack mixes every chunk (searches, reads, annotates) —
    // pointing `undo` at that picks up whatever was touched last, not the
    // last actual edit. Undo is edit-scoped, so field-aware resolution
    // redirects plain `$last` to the edit stack when the field is `undo`.
    setRecencyResolver(() => 'GENERIC-WRONG');
    setEditRecencyResolver(() => 'EDIT-RIGHT');

    expect(resolveRecencyInString('h:$last', 'undo')).toBe('h:EDIT-RIGHT');
    // Other fields keep generic-stack semantics.
    expect(resolveRecencyInString('h:$last', 'body')).toBe('h:GENERIC-WRONG');
    // Explicit $last_edit still works regardless of field.
    expect(resolveRecencyInString('h:$last_edit', 'body')).toBe('h:EDIT-RIGHT');
  });

  it('undo: "h:$last-N" routes to the EDIT recency stack with offset', () => {
    setRecencyResolver(() => 'GENERIC-WRONG');
    setEditRecencyResolver((offset) => `EDIT-${offset}`);

    expect(resolveRecencyInString('h:$last-2', 'undo')).toBe('h:EDIT-2');
  });

  it('resolveRecencyInString preserves modifier chain on h:$last:60-80', () => {
    setRecencyResolver((offset) => offset === 0 ? 'aabb1122' : null);
    const result = resolveRecencyInString('h:$last:60-80');
    expect(result).toBe('h:aabb1122:60-80');
  });

  it('resolveRecencyInString preserves modifier chain on h:$last_edit:sig', () => {
    setEditRecencyResolver((offset) => offset === 0 ? 'ccdd3344' : null);
    const result = resolveRecencyInString('h:$last_edit:sig');
    expect(result).toBe('h:ccdd3344:sig');
  });

  it('resolveRecencyInString handles h:$last-1:1-10,60-70', () => {
    setRecencyResolver((offset) => offset === 1 ? 'eeff5566' : null);
    const result = resolveRecencyInString('h:$last-1:1-10,60-70');
    expect(result).toBe('h:eeff5566:1-10,60-70');
  });

  it('resolveRecencyInString passes through bare h:$last (no modifier)', () => {
    setRecencyResolver((offset) => offset === 0 ? 'aabb1122' : null);
    const result = resolveRecencyInString('h:$last');
    expect(result).toBe('h:aabb1122');
  });

  it('resolveRecencyInString leaves unresolvable ref unchanged', () => {
    setRecencyResolver(() => null);
    expect(resolveRecencyInString('h:$last:60-80')).toBe('h:$last:60-80');
  });

  it('ref field is passthrough — read.lines h:HASH:lines must not expand to content', async () => {
    const lookup: HashLookup = async () => ({ content: 'FULL_FILE', source: 'a.ts' });
    const out = await resolveHashRefsInParams(
      { ref: 'h:abc12345:60-80' },
      lookup,
    );
    expect((out as Record<string, unknown>).ref).toBe('h:abc12345:60-80');
  });
});

// ── Set operations (union/intersect/difference) ──

describe('set operations', () => {
  const mockSetLookup: SetRefLookup = (selector: SetSelector): SetRefResult => {
    switch (selector.kind) {
      case 'edited':
        return {
          hashes: ['aabb1122', 'ccdd3344'],
          entries: [
            { content: 'fn foo() {}', source: 'src/foo.ts' },
            { content: 'fn bar() {}', source: 'src/bar.ts' },
          ],
        };
      case 'pinned':
        return {
          hashes: ['ccdd3344', 'eeff5566'],
          entries: [
            { content: 'fn bar() {}', source: 'src/bar.ts' },
            { content: 'fn baz() {}', source: 'src/baz.ts' },
          ],
        };
      case 'all':
        return {
          hashes: ['aabb1122', 'ccdd3344', 'eeff5566', 'ff001122'],
          entries: [
            { content: 'fn foo() {}', source: 'src/foo.ts' },
            { content: 'fn bar() {}', source: 'src/bar.ts' },
            { content: 'fn baz() {}', source: 'src/baz.ts' },
            { content: 'fn qux() {}', source: 'src/qux.ts' },
          ],
        };
      default:
        return { hashes: [], entries: [] };
    }
  };

  it('union: h:@edited+h:@pinned combines without duplicates', () => {
    const r = parseSetRef('h:@edited+h:@pinned');
    expect(r).not.toBeNull();
    expect(r).toHaveProperty('op', '+');
    const composite = r as CompositeSetRef;
    const { values, expansion } = resolveCompositeSetRef(composite, 'h:@edited+h:@pinned', undefined, mockSetLookup);
    expect(values).toHaveLength(3);
    expect(expansion.matchedCount).toBe(3);
    expect(values).toContain('src/foo.ts');
    expect(values).toContain('src/bar.ts');
    expect(values).toContain('src/baz.ts');
  });

  it('intersection: h:@edited&h:@pinned returns only shared', () => {
    const r = parseSetRef('h:@edited&h:@pinned');
    expect(r).not.toBeNull();
    expect(r).toHaveProperty('op', '&');
    const composite = r as CompositeSetRef;
    const { values, expansion } = resolveCompositeSetRef(composite, 'h:@edited&h:@pinned', undefined, mockSetLookup);
    expect(values).toHaveLength(1);
    expect(expansion.matchedCount).toBe(1);
    expect(values[0]).toBe('src/bar.ts');
  });

  it('difference: h:@all-h:@pinned removes pinned from all', () => {
    const r = parseSetRef('h:@all-h:@pinned');
    expect(r).not.toBeNull();
    expect(r).toHaveProperty('op', '-');
    const composite = r as CompositeSetRef;
    const { values, expansion } = resolveCompositeSetRef(composite, 'h:@all-h:@pinned', undefined, mockSetLookup);
    expect(values).toHaveLength(2);
    expect(expansion.matchedCount).toBe(2);
    expect(values).toContain('src/foo.ts');
    expect(values).toContain('src/qux.ts');
    expect(values).not.toContain('src/bar.ts');
    expect(values).not.toContain('src/baz.ts');
  });

  it('union with empty right returns left unchanged', () => {
    const composite: CompositeSetRef = {
      left: { kind: 'edited' },
      op: '+',
      right: { kind: 'subtask', id: 'nonexistent' },
      modifier: 'auto',
    };
    const { values } = resolveCompositeSetRef(composite, 'test', undefined, mockSetLookup);
    expect(values).toHaveLength(2);
  });

  it('intersection with empty right returns empty', () => {
    const composite: CompositeSetRef = {
      left: { kind: 'edited' },
      op: '&',
      right: { kind: 'subtask', id: 'nonexistent' },
      modifier: 'auto',
    };
    const { values } = resolveCompositeSetRef(composite, 'test', undefined, mockSetLookup);
    expect(values).toHaveLength(0);
  });

  it('file field context returns source paths for union', () => {
    const composite: CompositeSetRef = {
      left: { kind: 'edited' },
      op: '+',
      right: { kind: 'pinned' },
      modifier: 'auto',
    };
    const { values } = resolveCompositeSetRef(composite, 'test', 'file_paths', mockSetLookup);
    expect(values.every(v => v.startsWith('src/'))).toBe(true);
  });

  it('hash field context returns raw hashes for union', () => {
    const composite: CompositeSetRef = {
      left: { kind: 'edited' },
      op: '+',
      right: { kind: 'pinned' },
      modifier: 'auto',
    };
    const { values } = resolveCompositeSetRef(composite, 'test', 'hash', mockSetLookup);
    expect(values).toContain('aabb1122');
    expect(values).toContain('ccdd3344');
    expect(values).toContain('eeff5566');
  });

  it('applies composite modifiers to each expanded entry', () => {
    const composite: CompositeSetRef = {
      left: { kind: 'edited' },
      op: '+',
      right: { kind: 'pinned' },
      modifier: { shape: 'sig' },
    };

    const { values } = resolveCompositeSetRef(composite, 'h:@edited+h:@pinned:sig', undefined, mockSetLookup);

    expect(values).toEqual([
      'fn foo() {}',
      'fn bar() {}',
      'fn baz() {}',
    ]);
  });
});

// ── Set ref resolution (resolveSetRefToValues) ──

describe('resolveSetRefToValues', () => {
  const mockSetLookup: SetRefLookup = (selector: SetSelector): SetRefResult => {
    if (selector.kind === 'file') {
      return {
        hashes: ['aabb1122', 'ccdd3344'],
        entries: [
          { content: 'fn foo() {}', source: 'src/foo.ts' },
          { content: 'fn bar() {}', source: 'src/bar.ts' },
        ],
      };
    }
    return { hashes: [], entries: [] };
  };

  it('resolves file selector to source paths in file field', () => {
    const setRef: ParsedSetRef = { selector: { kind: 'file', pattern: '*.ts' }, modifier: 'auto' };
    const { values, expansion } = resolveSetRefToValues(setRef, 'h:@file=*.ts', 'file_path', mockSetLookup);
    expect(values).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(expansion.matchedCount).toBe(2);
  });

  it('resolves file selector to content in content field', () => {
    const setRef: ParsedSetRef = { selector: { kind: 'file', pattern: '*.ts' }, modifier: 'auto' };
    const { values } = resolveSetRefToValues(setRef, 'h:@file=*.ts', 'body', mockSetLookup);
    expect(values).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('resolves file selector to hashes in hash field', () => {
    const setRef: ParsedSetRef = { selector: { kind: 'file', pattern: '*.ts' }, modifier: 'auto' };
    const { values } = resolveSetRefToValues(setRef, 'h:@file=*.ts', 'hash', mockSetLookup);
    expect(values).toEqual(['aabb1122', 'ccdd3344']);
  });

  it('returns empty for non-matching selector', () => {
    const setRef: ParsedSetRef = { selector: { kind: 'subtask', id: 'nope' }, modifier: 'auto' };
    const { values, expansion } = resolveSetRefToValues(setRef, 'h:@sub:nope', undefined, mockSetLookup);
    expect(values).toHaveLength(0);
    expect(expansion.matchedCount).toBe(0);
  });

  it('expansion metadata contains short hashes', () => {
    const setRef: ParsedSetRef = { selector: { kind: 'file', pattern: '*.ts' }, modifier: 'auto' };
    const { expansion } = resolveSetRefToValues(setRef, 'h:@file=*.ts', undefined, mockSetLookup);
    expect(expansion.hashes).toEqual(['h:aabb11', 'h:ccdd33']);
    expect(expansion.sources).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('applies modifiers to each expanded set entry', () => {
    const setRef: ParsedSetRef = {
      selector: { kind: 'file', pattern: '*.ts' },
      modifier: { shape: 'sig' },
    };

    const { values } = resolveSetRefToValues(setRef, 'h:@file=*.ts:sig', undefined, mockSetLookup);

    expect(values).toEqual(['fn foo() {}', 'fn bar() {}']);
  });
});

// ── Integration: set operations through full resolve pipeline ──

describe('set operations through resolve pipeline', () => {
  const mockLookup: HashLookup = async (hash) => {
    const store: Record<string, { content: string; source: string }> = {
      'aabb1122': { content: 'fn foo() {}', source: 'src/foo.ts' },
      'ccdd3344': { content: 'fn bar() {}', source: 'src/bar.ts' },
      'eeff5566': { content: 'fn baz() {}', source: 'src/baz.ts' },
    };
    return store[hash] ?? null;
  };

  const mockSetLookup: SetRefLookup = (selector: SetSelector): SetRefResult => {
    switch (selector.kind) {
      case 'edited':
        return {
          hashes: ['aabb1122', 'ccdd3344'],
          entries: [
            { content: 'fn foo() {}', source: 'src/foo.ts' },
            { content: 'fn bar() {}', source: 'src/bar.ts' },
          ],
        };
      case 'pinned':
        return {
          hashes: ['ccdd3344', 'eeff5566'],
          entries: [
            { content: 'fn bar() {}', source: 'src/bar.ts' },
            { content: 'fn baz() {}', source: 'src/baz.ts' },
          ],
        };
      default:
        return { hashes: [], entries: [] };
    }
  };

  it('resolves union set ref in string param', async () => {
    const { params, setRefExpansions } = await resolveHashRefsWithMeta(
      { targets: 'h:@edited+h:@pinned' },
      mockLookup,
      undefined,
      mockSetLookup,
    );
    const result = (params as Record<string, unknown>).targets;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(setRefExpansions).toHaveLength(1);
    expect(setRefExpansions[0].matchedCount).toBe(3);
  });

  it('resolves intersection set ref in string param', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { targets: 'h:@edited&h:@pinned' },
      mockLookup,
      undefined,
      mockSetLookup,
    );
    const result = (params as Record<string, unknown>).targets;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('resolves difference set ref in string param', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { targets: 'h:@edited-h:@pinned' },
      mockLookup,
      undefined,
      mockSetLookup,
    );
    const result = (params as Record<string, unknown>).targets;
    expect(result).toEqual(['src/foo.ts']);
  });

  it('resolves set ref in array param (expands inline)', async () => {
    const { params } = await resolveHashRefsWithMeta(
      { file_paths: ['h:@edited', 'h:eeff5566:source'] },
      mockLookup,
      undefined,
      mockSetLookup,
    );
    const result = (params as Record<string, string[]>).file_paths;
    expect(result).toContain('src/foo.ts');
    expect(result).toContain('src/bar.ts');
    expect(result).toContain('src/baz.ts');
  });
});

// ── Integration: edit chaining (h:$last -> edit -> h:$last -> edit) ──

describe('edit chaining via recency refs', () => {
  beforeEach(() => {
    setRecencyResolver(null as unknown as (offset: number) => string | null);
    setEditRecencyResolver(null as unknown as (offset: number) => string | null);
  });

  it('simulates multi-step edit chain with h:$last', async () => {
    const contentStore: Record<string, { content: string; source: string }> = {
      'aa110011': { content: 'function foo() { return 1; }', source: 'src/foo.ts' },
      'bb220022': { content: 'function foo() { return 2; }', source: 'src/foo.ts' },
    };

    const lookup: HashLookup = async (hash) => contentStore[hash] ?? null;

    const recencyStack = ['aa110011'];
    setRecencyResolver((offset) => offset < recencyStack.length ? recencyStack[offset] : null);

    const step1 = await resolveHashRefsInParams(
      { body: 'h:$last', file: 'h:aa110011:source' },
      lookup,
    );
    expect((step1 as Record<string, unknown>).body).toBe('function foo() { return 1; }');
    expect((step1 as Record<string, unknown>).file).toBe('src/foo.ts');

    recencyStack.unshift('bb220022');
    setRecencyResolver((offset) => offset < recencyStack.length ? recencyStack[offset] : null);

    const step2 = await resolveHashRefsInParams(
      { body: 'h:$last', prev: 'h:$last-1' },
      lookup,
    );
    expect((step2 as Record<string, unknown>).body).toBe('function foo() { return 2; }');
    expect((step2 as Record<string, unknown>).prev).toBe('function foo() { return 1; }');
  });

  it('simulates edit chain with h:$last_edit', async () => {
    const contentStore: Record<string, { content: string; source: string }> = {
      'dd110011': { content: 'v1 content', source: 'src/v1.ts' },
      'ee220022': { content: 'v2 content', source: 'src/v2.ts' },
    };

    const lookup: HashLookup = async (hash) => contentStore[hash] ?? null;

    const editStack = ['ee220022', 'dd110011'];
    setEditRecencyResolver((offset) => offset < editStack.length ? editStack[offset] : null);

    const result = await resolveHashRefsInParams(
      { current: 'h:$last_edit', previous: 'h:$last_edit-1' },
      lookup,
    );
    expect((result as Record<string, unknown>).current).toBe('v2 content');
    expect((result as Record<string, unknown>).previous).toBe('v1 content');
  });

  it('mixed h:$last and h:$last_edit resolve independently', async () => {
    const contentStore: Record<string, { content: string; source: string }> = {
      'ff001122': { content: 'recency content', source: 'src/r.ts' },
      'aa003344': { content: 'edit content', source: 'src/e.ts' },
    };

    const lookup: HashLookup = async (hash) => contentStore[hash] ?? null;

    setRecencyResolver((offset) => offset === 0 ? 'ff001122' : null);
    setEditRecencyResolver((offset) => offset === 0 ? 'aa003344' : null);

    const result = await resolveHashRefsInParams(
      { last: 'h:$last', lastEdit: 'h:$last_edit' },
      lookup,
    );
    expect((result as Record<string, unknown>).last).toBe('recency content');
    expect((result as Record<string, unknown>).lastEdit).toBe('edit content');
  });
});

// ── Phase 1: Shaped content safety ──

describe('shaped content safety', () => {
  const SHAPED_CONTENT = [
    'export class MyClass { ... }',
    'export function doStuff(a: string): void { /* ... */ }',
  ].join('\n');

  const FULL_CONTENT = [
    'export class MyClass {',
    '  private value = 42;',
    '  getValue() { return this.value; }',
    '}',
    'export function doStuff(a: string): void {',
    '  console.log(a);',
    '}',
  ].join('\n');

  it('throws on symbol anchor against shaped content (strict path via resolveSingle)', async () => {
    const lookup: HashLookup = async (hash) => {
      if (hash === 'aabb1122') return { content: SHAPED_CONTENT, source: 'src/mod.ts' };
      return null;
    };

    await expect(
      resolveHashRefsInParams({ body: 'h:aabb1122:cls(MyClass)' }, lookup),
    ).rejects.toThrow(/shaped/i);
  });

  it('throws on symbol anchor against shaped content (lenient path via set entry)', async () => {
    const lookup: HashLookup = async (hash) => {
      if (hash === 'aabb1122') return { content: SHAPED_CONTENT, source: 'src/mod.ts' };
      return null;
    };

    await expect(
      resolveHashRefsWithMeta({ content: 'h:aabb1122:cls(MyClass)' }, lookup),
    ).rejects.toThrow(/shaped/i);
  });

  it('collects warning for inline ref with shaped content', async () => {
    const lookup: HashLookup = async (hash) => {
      if (hash === 'aabb1122') return { content: SHAPED_CONTENT, source: 'src/mod.ts' };
      return null;
    };

    const { params, warnings } = await resolveHashRefsWithMeta(
      { content: 'import { MyClass } from "./mod";\n\nh:aabb1122:cls(MyClass):dedent' },
      lookup,
    );
    const content = (params as Record<string, unknown>).content as string;
    expect(content).toContain('h:aabb1122:cls(MyClass):dedent');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/shaped|bodies stripped/i);
  });

  it('resolves symbol anchor against full content without error', async () => {
    const lookup: HashLookup = async (hash) => {
      if (hash === 'ccdd3344') return { content: FULL_CONTENT, source: 'src/mod.ts' };
      return null;
    };

    const { params, warnings } = await resolveHashRefsWithMeta(
      { content: 'h:ccdd3344:cls(MyClass):dedent' },
      lookup,
    );
    const content = (params as Record<string, unknown>).content as string;
    expect(content).not.toContain('h:ccdd3344');
    expect(content).toContain('class MyClass');
    expect(warnings).toHaveLength(0);
  });

  it('warnings array is always present in resolveHashRefsWithMeta result', async () => {
    const lookup: HashLookup = async () => ({ content: 'hello', source: 'a.ts' });
    const result = await resolveHashRefsWithMeta({ x: 'plain' }, lookup);
    expect(result).toHaveProperty('warnings');
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('skips ref with modifier inside // comment, resolves same ref on own line', async () => {
    const lookup: HashLookup = async (hash) => {
      if (hash === 'ccdd3344') return { content: FULL_CONTENT, source: 'src/mod.ts' };
      return null;
    };

    const input = [
      '// Do not resolve: h:ccdd3344:cls(MyClass)',
      'h:ccdd3344:cls(MyClass):dedent',
    ].join('\n');

    const { params, warnings } = await resolveHashRefsWithMeta(
      { content: input },
      lookup,
    );
    const content = (params as Record<string, unknown>).content as string;
    expect(content).toContain('// Do not resolve: h:ccdd3344:cls(MyClass)');
    expect(content).toContain('class MyClass');
    expect(warnings.some(w => w.includes('inside comment'))).toBe(true);
  });

  it('skips ref inside # comment (Python/shell)', async () => {
    const lookup: HashLookup = async (hash) => {
      if (hash === 'ccdd3344') return { content: FULL_CONTENT, source: 'src/mod.ts' };
      return null;
    };

    const { params } = await resolveHashRefsWithMeta(
      { content: '# source: h:ccdd3344:cls(MyClass)\nh:ccdd3344:cls(MyClass):dedent' },
      lookup,
    );
    const content = (params as Record<string, unknown>).content as string;
    expect(content).toContain('# source: h:ccdd3344:cls(MyClass)');
    expect(content).toContain('class MyClass');
  });
});