import { describe, expect, it } from 'vitest';

import { estimateTokens } from './contextHash';
import {
  toTOON,
  formatResult,
  serializeForTokenEstimate,
  serializeMessageContentForTokens,
  estimateImageContentTokens,
  estimateSingleImageTokens,
  FORMAT_RESULT_MAX_DEFAULT,
  FORMAT_RESULT_MAX_SEARCH,
  FORMAT_RESULT_MAX_GIT,
} from './toon';
import {
  logTokenDelta,
  logObjectJsonVsToon,
  logObjectJsonVsFormatResult,
  logObjectJsonVsSerializeForTokenEstimate,
} from './toonDeltaTestHelpers';
import {
  makeCreateFilesResult,
  makeGitCommitResult,
  makeGitDiffResult,
  makeGitStatusResult,
  makeLineEditResult,
  makeRefactorResult,
} from './toonFixtures';

/**
 * Token cost comparison: JSON.stringify vs TOON serialization.
 *
 * These fixtures mirror real Rust backend response shapes from batch_query/mod.rs.
 * The test quantifies token savings to justify converting all model-facing
 * handlers from JSON.stringify to toTOON/formatResult.
 */

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TOON vs JSON token cost', () => {
  const fixtures: Array<{ name: string; data: unknown }> = [
    { name: 'git diff (small, 30 hunk lines)', data: makeGitDiffResult(30) },
    { name: 'git diff (medium, 100 hunk lines)', data: makeGitDiffResult(100) },
    { name: 'git diff (large, 300 hunk lines)', data: makeGitDiffResult(300) },
    { name: 'git status', data: makeGitStatusResult() },
    { name: 'git commit', data: makeGitCommitResult() },
    { name: 'line_edits result', data: makeLineEditResult() },
    { name: 'create_files result', data: makeCreateFilesResult() },
    { name: 'refactor result', data: makeRefactorResult() },
  ];

  for (const { name, data } of fixtures) {
    it(`${name}: TOON uses significantly fewer tokens than JSON`, () => {
      const { jsonTok, altTok } = logObjectJsonVsToon(name, data);
      expect(altTok).toBeLessThan(jsonTok);
    });
  }

  it('formatResult (TOON + file compaction) saves even more on multi-file results', () => {
    const data = makeGitDiffResult(100);
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('formatResult vs JSON (100-line diff)', data);
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('session aggregate: 20 edits + 3 diffs + 5 git ops', () => {
    const sessionOps = [
      ...Array.from({ length: 20 }, () => makeLineEditResult()),
      ...Array.from({ length: 3 }, () => makeGitDiffResult(100)),
      ...Array.from({ length: 3 }, () => makeGitStatusResult()),
      makeGitCommitResult(),
      makeCreateFilesResult(),
    ];

    let totalJsonTokens = 0;
    let totalToonTokens = 0;

    for (const op of sessionOps) {
      totalJsonTokens += estimateTokens(JSON.stringify(op));
      totalToonTokens += estimateTokens(toTOON(op));
    }

    const saved = totalJsonTokens - totalToonTokens;
    const pct = ((saved / totalJsonTokens) * 100).toFixed(1);

    const seenJson = new Set<string>();
    let uniqueIdx = 0;
    for (let i = 0; i < sessionOps.length; i++) {
      const op = sessionOps[i];
      const key = JSON.stringify(op);
      if (seenJson.has(key)) continue;
      seenJson.add(key);
      const count = sessionOps.reduce((n, o) => n + (JSON.stringify(o) === key ? 1 : 0), 0);
      uniqueIdx += 1;
      logObjectJsonVsToon(`session unique payload ${uniqueIdx} (${count}x in mix)`, op);
    }
    console.log(
      `[TOON delta] session aggregate (sum of per-op estimateTokens) | JSON: ${totalJsonTokens} tok | TOON: ${totalToonTokens} tok | Δ ${saved} tok (${pct}%)`,
    );

    expect(totalToonTokens).toBeLessThan(totalJsonTokens);
    expect(saved).toBeGreaterThan(0);
  });

  it('metadata-heavy results (no long strings) show larger TOON savings', () => {
    const metadataHeavy = {
      file: 'src/services/batch/handlers/system.ts',
      h: 'h:a3f1b2',
      old_h: 'h:50b982',
      status: 'applied',
      edits_applied: 3,
      has_errors: true,
      stale: false,
      lints: {
        total: 5,
        by_severity: { error: 2, warning: 3 },
        top_issues: [
          { file: 'system.ts', line: 153, severity: 'error', message: 'Type mismatch', rule: 'ts2322' },
          { file: 'system.ts', line: 170, severity: 'warning', message: 'Unused var', rule: 'no-unused-vars' },
          { file: 'system.ts', line: 185, severity: 'error', message: 'Missing return', rule: 'ts2355' },
          { file: 'system.ts', line: 200, severity: 'warning', message: 'Prefer const', rule: 'prefer-const' },
          { file: 'system.ts', line: 220, severity: 'warning', message: 'No explicit any', rule: 'ts7006' },
        ],
      },
      index: { indexed: 1, duration_ms: 45, symbols_added: 12, symbols_removed: 3 },
      dry_run: false,
      authority_warnings: [],
    };

    const { jsonTok, altTok: toonTok } = logObjectJsonVsToon('metadata-heavy: toTOON', metadataHeavy);
    logObjectJsonVsFormatResult('metadata-heavy: formatResult', metadataHeavy);

    expect(toonTok).toBeLessThan(jsonTok * 0.85);
  });

  it('boolean-heavy git status shows TOON boolean compression', () => {
    const statusWithFlags = {
      action: 'status',
      branch: 'feature/toon-migration',
      ahead: 3,
      behind: 0,
      staged: ['src/a.ts', 'src/b.ts'],
      modified: ['src/c.ts', 'src/d.ts', 'src/e.ts'],
      untracked: ['src/f.ts'],
      deleted: [],
      clean: false,
      has_conflicts: false,
      rebase_in_progress: false,
      merge_in_progress: false,
    };

    const { jsonTok, altTok: toonTok } = logObjectJsonVsToon('boolean-heavy git status', statusWithFlags);

    expect(toonTok).toBeLessThan(jsonTok * 0.90);
  });
});

describe('serializeForTokenEstimate and formatResult limits', () => {
  it('serializeForTokenEstimate matches formatResult shape without truncation for small objects', () => {
    const o = { a: 1, b: { c: 'x' } };
    logObjectJsonVsSerializeForTokenEstimate('limits: small nested object (vs JSON)', o);
    expect(serializeForTokenEstimate(o)).toBe(formatResult(o, 1_000_000));
  });

  it('formatResult truncates at default max', () => {
    const huge = { x: 'y'.repeat(FORMAT_RESULT_MAX_DEFAULT + 500) };
    const jsonStr = JSON.stringify(huge);
    const out = formatResult(huge);
    logTokenDelta('limits: formatResult default max (truncated vs full JSON)', jsonStr, out, 'formatResult');
    expect(out.length).toBeLessThanOrEqual(FORMAT_RESULT_MAX_DEFAULT + 80);
    expect(out).toContain('[truncated - narrow query]');
  });

  it('search max allows larger payloads before truncation', () => {
    const pad = FORMAT_RESULT_MAX_SEARCH - 1000;
    const huge = { blob: 'z'.repeat(pad) };
    const jsonStr = JSON.stringify(huge);
    const out = formatResult(huge, FORMAT_RESULT_MAX_SEARCH);
    logTokenDelta('limits: formatResult SEARCH max (no truncation)', jsonStr, out, 'formatResult');
    expect(out).not.toContain('[truncated - narrow query]');
  });

  it('exported max constants are ordered', () => {
    console.log(
      `[TOON delta] limits: FORMAT_RESULT_MAX_DEFAULT=${FORMAT_RESULT_MAX_DEFAULT} ` +
        `MAX_GIT=${FORMAT_RESULT_MAX_GIT} MAX_SEARCH=${FORMAT_RESULT_MAX_SEARCH} (chars, not tok)`,
    );
    expect(FORMAT_RESULT_MAX_DEFAULT).toBeLessThan(FORMAT_RESULT_MAX_GIT);
    expect(FORMAT_RESULT_MAX_GIT).toBeLessThan(FORMAT_RESULT_MAX_SEARCH);
  });
});

// ============================================================================
// parseBatchLines + expandBatchQ tests
// ============================================================================

import { parseBatchLines, expandBatchQ, jsObjectToJson } from './toon';

describe('jsObjectToJson', () => {
  it('quotes unquoted keys', () => {
    expect(JSON.parse(jsObjectToJson('{a:1,b:"hello"}'))).toEqual({ a: 1, b: 'hello' });
  });

  it('quotes bare identifier values', () => {
    expect(JSON.parse(jsObjectToJson('{id:r1,use:search}'))).toEqual({ id: 'r1', use: 'search' });
  });

  it('preserves true/false/null as literals', () => {
    expect(JSON.parse(jsObjectToJson('{a:true,b:false,c:null}'))).toEqual({ a: true, b: false, c: null });
  });

  it('handles nested objects', () => {
    const input = '{line:10,action:replace,count:1,content:"const x = 1;"}';
    const parsed = JSON.parse(jsObjectToJson(input));
    expect(parsed).toEqual({ line: 10, action: 'replace', count: 1, content: 'const x = 1;' });
  });

  it('strips trailing commas', () => {
    expect(JSON.parse(jsObjectToJson('{a:1,b:2,}'))).toEqual({ a: 1, b: 2 });
  });

  it('handles arrays', () => {
    expect(JSON.parse(jsObjectToJson('[{id:r1},{id:r2}]'))).toEqual([{ id: 'r1' }, { id: 'r2' }]);
  });

  it('converts single-quoted strings to double-quoted JSON (B5 fix)', () => {
    const parsed = JSON.parse(jsObjectToJson("{content:'hello world'}"));
    expect(parsed).toEqual({ content: 'hello world' });
  });

  it('escapes inner double quotes when converting single-quoted strings (B5 fix)', () => {
    const parsed = JSON.parse(jsObjectToJson('{content:\'say "hi"\'}'));
    expect(parsed).toEqual({ content: 'say "hi"' });
  });

  it('converts backtick strings to double-quoted JSON (B5 fix)', () => {
    const parsed = JSON.parse(jsObjectToJson('{content:`template ${expr}`}'));
    expect(parsed).toEqual({ content: 'template ${expr}' });
  });

  it('handles bracket-heavy content in single-quoted strings (B5 fix)', () => {
    const input = "{content:'arr.reduce<Record<string,number>>((a,b) => a, {})'}";
    const parsed = JSON.parse(jsObjectToJson(input));
    expect(parsed).toEqual({ content: 'arr.reduce<Record<string,number>>((a,b) => a, {})' });
  });
});

describe('parseBatchLines', () => {
  it('parses a single step', () => {
    const result = parseBatchLines('r1 read.context type:smart file_paths:src/api.ts');
    expect(result.version).toBe('1.0');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toEqual({
      id: 'r1',
      use: 'read.context',
      with: { type: 'smart', file_paths: 'src/api.ts' },
    });
  });

  it('parses 3 steps', () => {
    const q = [
      'r1 read.context depth:2 file_paths:atls-studio/src/services type:tree',
      'r2 search.code limit:5 queries:executeUnifiedBatch',
      'r3 session.stats',
    ].join('\n');
    const result = parseBatchLines(q);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]).toEqual({
      id: 'r1',
      use: 'read.context',
      with: { depth: 2, file_paths: 'atls-studio/src/services', type: 'tree' },
    });
    expect(result.steps[1]).toEqual({
      id: 'r2',
      use: 'search.code',
      with: { limit: 5, queries: 'executeUnifiedBatch' },
    });
    expect(result.steps[2]).toEqual({ id: 'r3', use: 'session.stats' });
  });

  it('parses comma-separated arrays', () => {
    const result = parseBatchLines('r1 read.context file_paths:src/api.ts,src/db.ts');
    expect(result.steps[0].with).toEqual({ file_paths: ['src/api.ts', 'src/db.ts'] });
  });

  it('parses dataflow shorthand', () => {
    const result = parseBatchLines('p1 session.pin in:r1.refs');
    expect(result.steps[0].in).toEqual({ hashes: { from_step: 'r1', path: 'refs' } });
    expect(result.steps[0].with).toBeUndefined();
  });

  it('parses conditional shorthand', () => {
    const result = parseBatchLines('v1 verify.typecheck if:e1.ok');
    expect(result.steps[0].if).toEqual({ step_ok: 'e1' });
  });

  it('parses on_error', () => {
    const result = parseBatchLines('e1 change.edit file_path:src/api.ts on_error:continue');
    expect(result.steps[0].on_error).toBe('continue');
  });

  it('parses inline JSON objects (line_edits)', () => {
    const q = 'e1 change.edit file_path:src/api.ts line_edits:[{line:10,action:replace,count:1,content:"const x = 1;"}]';
    const result = parseBatchLines(q);
    const w = result.steps[0].with as Record<string, unknown>;
    expect(w.file_path).toBe('src/api.ts');
    expect(Array.isArray(w.line_edits)).toBe(true);
    const edit = (w.line_edits as Record<string, unknown>[])[0];
    expect(edit.line).toBe(10);
    expect(edit.action).toBe('replace');
    expect(edit.content).toBe('const x = 1;');
  });

  it('parses complex 5-step batch with all features', () => {
    const q = [
      'r1 read.context type:smart file_paths:src/api.ts,src/db.ts',
      'p1 session.pin in:r1.refs',
      'e1 change.edit file_path:src/api.ts line_edits:[{line:10,action:replace,count:1,content:"const x = 1;"}]',
      'v1 verify.typecheck if:e1.ok',
      's1 session.stats',
    ].join('\n');
    const result = parseBatchLines(q);
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0].with).toEqual({ type: 'smart', file_paths: ['src/api.ts', 'src/db.ts'] });
    expect(result.steps[1].in).toEqual({ hashes: { from_step: 'r1', path: 'refs' } });
    expect((result.steps[2].with as Record<string, unknown>).file_path).toBe('src/api.ts');
    expect(result.steps[3].if).toEqual({ step_ok: 'e1' });
    expect(result.steps[4]).toEqual({ id: 's1', use: 'session.stats' });
  });

  it('skips blank lines and trims whitespace', () => {
    const q = '\n  r1 session.stats  \n\n  r2 session.stats\n';
    const result = parseBatchLines(q);
    expect(result.steps).toHaveLength(2);
  });

  it('handles numeric values', () => {
    const result = parseBatchLines('r1 read.context depth:3 max_lines:100');
    expect(result.steps[0].with).toEqual({ depth: 3, max_lines: 100 });
  });

  it('normalizes op shorthand codes to canonical names', () => {
    const result = parseBatchLines('r1 sc qs:foo ps:a.ts');
    expect(result.steps[0].use).toBe('search.code');
    expect(result.steps[0].with).toEqual({ qs: 'foo', ps: 'a.ts' });
  });

  it('normalizes 3-char shorthand codes', () => {
    const q = [
      'p1 spl goal:"refactor"',
      'r1 rec',
      's1 srv directory:src depth:2',
    ].join('\n');
    const result = parseBatchLines(q);
    expect(result.steps[0].use).toBe('session.plan');
    expect(result.steps[1].use).toBe('session.recall');
    expect(result.steps[2].use).toBe('intent.survey');
  });

  it('normalizes mixed shorthand and canonical in same batch', () => {
    const q = [
      'r1 rc type:smart ps:src/api.ts',
      'p1 session.pin in:r1.refs',
      'e1 ce f:h:abc:10-20 le:[{content:"x"}]',
      'v1 vk if:e1.ok',
    ].join('\n');
    const result = parseBatchLines(q);
    expect(result.steps[0].use).toBe('read.context');
    expect(result.steps[1].use).toBe('session.pin');
    expect(result.steps[2].use).toBe('change.edit');
    expect(result.steps[3].use).toBe('verify.typecheck');
  });

  it('parses single-quoted content with brackets in le array (B5 fix)', () => {
    const q = "e1 ce f:test.ts le:[{line:1,content:'const x = arr.reduce<Record<string,number>>((a,b) => a, {})'}]";
    const result = parseBatchLines(q);
    expect(result.steps).toHaveLength(1);
    const le = result.steps[0].with.le as unknown[];
    expect(le).toHaveLength(1);
    expect((le[0] as Record<string, unknown>).content).toBe(
      'const x = arr.reduce<Record<string,number>>((a,b) => a, {})',
    );
  });

  it('parses backtick-quoted content with ${} in le array (B5 fix)', () => {
    const q = 'e1 ce f:test.ts le:[{line:5,content:`const msg = ${name}`}]';
    const result = parseBatchLines(q);
    expect(result.steps).toHaveLength(1);
    const le = result.steps[0].with.le as unknown[];
    expect(le).toHaveLength(1);
    expect((le[0] as Record<string, unknown>).content).toBe('const msg = ${name}');
  });

  it('routes bare h:XXXX token to hashes array', () => {
    const result = parseBatchLines('r1 rec h:deadbeef');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].with).toEqual({ hashes: ['h:deadbeef'] });
  });

  it('accumulates multiple h: tokens into single hashes array', () => {
    const result = parseBatchLines('r1 rec h:aaa111 h:bbb222');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].with).toEqual({ hashes: ['h:aaa111', 'h:bbb222'] });
  });

  it('preserves h: tokens with line-spec modifiers', () => {
    const result = parseBatchLines('r1 rec h:deadbeef:10-20');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].with).toEqual({ hashes: ['h:deadbeef:10-20'] });
  });

  it('rewrites `hashes:in:STEP.refs` to proper `in:` dataflow and warns', () => {
    // AI sometimes conflates the two pin forms: `hashes:in:r1.refs` is
    // neither a hash list nor a dataflow ref. Parser should auto-correct to
    // `in:r1.refs` (so the step works) and surface a warning.
    const result = parseBatchLines('p1 session.pin hashes:in:r1.refs');
    expect(result.steps).toHaveLength(1);
    const step = result.steps[0];
    expect(step.in).toEqual({ hashes: { from_step: 'r1', path: 'refs' } });
    expect(step.with).toBeUndefined();
    const warnings = step._parseWarnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.length).toBeGreaterThan(0);
    expect(warnings![0]).toMatch(/hashes:in:r1\.refs/);
    expect(warnings![0]).toMatch(/in:STEP\.refs/);
  });

  it('does not auto-correct legitimate `hashes:in:...` when value has nested colons', () => {
    // A value like `hashes:in:key:val` is not a recognizable dataflow
    // shorthand and should pass through as a raw param (or fail downstream)
    // rather than silently being rewritten.
    const result = parseBatchLines('p1 session.pin hashes:in:not-a-step.hash:foo');
    const step = result.steps[0];
    expect(step.in).toBeUndefined();
    expect(step._parseWarnings).toBeUndefined();
  });
});

describe('expandBatchQ', () => {
  it('expands q string to structured request', () => {
    const result = expandBatchQ({ q: 'r1 session.stats' });
    expect(result).toEqual({ version: '1.0', steps: [{ id: 'r1', use: 'session.stats' }] });
  });

  it('passes through legacy structured args unchanged', () => {
    const legacy = { version: '1.0', steps: [{ id: 'r1', use: 'session.stats' }] };
    expect(expandBatchQ(legacy)).toBe(legacy);
  });

  it('passes through args without q field', () => {
    const args = { foo: 'bar' };
    expect(expandBatchQ(args)).toBe(args);
  });
});

describe('image content serialization & token estimation', () => {
  const bigBase64 = 'A'.repeat(10_000); // simulated 10KB base64 payload

  it('serializeMessageContentForTokens drops image `data` field', () => {
    const content = [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bigBase64 } },
    ];
    const out = serializeMessageContentForTokens(content);
    // The marker is present, the base64 payload is NOT.
    expect(out).toContain('[image image/jpeg]');
    expect(out).not.toContain(bigBase64);
    expect(out.length).toBeLessThan(200);
  });

  it('estimateSingleImageTokens applies Anthropic formula by default', () => {
    // 1568*1568 / 750 = 3278
    expect(estimateSingleImageTokens(1568, 1568)).toBe(Math.ceil((1568 * 1568) / 750));
    // 1920*1080 / 750 ≈ 2765
    expect(estimateSingleImageTokens(1920, 1080)).toBe(Math.ceil((1920 * 1080) / 750));
  });

  it('estimateSingleImageTokens uses tile math for OpenAI', () => {
    // 1024x1024 → 2x2 = 4 tiles → 85 + 170*4 = 765
    expect(estimateSingleImageTokens(1024, 1024, 'openai')).toBe(85 + 170 * 4);
  });

  it('estimateImageContentTokens sums image blocks and ignores text', () => {
    const content = [
      { type: 'text', text: 'hi' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'x' },
        _dimensions: { width: 1920, height: 1080 },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/webp', data: 'y' },
        _dimensions: { width: 1024, height: 1024 },
      },
    ];
    const expected =
      estimateSingleImageTokens(1920, 1080) + estimateSingleImageTokens(1024, 1024);
    expect(estimateImageContentTokens(content)).toBe(expected);
  });

  it('estimateImageContentTokens returns 0 for non-arrays and image-free arrays', () => {
    expect(estimateImageContentTokens('hello')).toBe(0);
    expect(estimateImageContentTokens([{ type: 'text', text: 'plain' }])).toBe(0);
    expect(estimateImageContentTokens(undefined)).toBe(0);
  });

  it('estimateImageContentTokens falls back to 1568x1568 default when dimensions missing', () => {
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'z' } },
    ];
    expect(estimateImageContentTokens(content)).toBe(estimateSingleImageTokens(1568, 1568));
  });
});
