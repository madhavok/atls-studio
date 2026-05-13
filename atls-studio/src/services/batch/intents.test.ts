import { describe, expect, it } from 'vitest';
import type { ChunkEntry, ContextStoreApi, IntentContext, StepOutput } from './types';
import { buildIntentContext, registerIntent, resolveIntents, makeStepId, isFileStaged, isFilePinned, getFileAwareness, estimateFileLines, normalizeIntentFilePaths } from './intents';
import { resolveUnderstand } from './intents/understand';
import { resolveEdit } from './intents/edit';
import { resolveEditMulti } from './intents/editMulti';
import { resolveInvestigate } from './intents/investigate';
import { resolveDiagnose } from './intents/diagnose';
import { resolveSurvey } from './intents/survey';
import { resolveRefactor } from './intents/refactor';
import { resolveCreate } from './intents/create';
import { resolveTest } from './intents/test';
import { resolveSearchReplace } from './intents/searchReplace';
import { resolveExtract } from './intents/extract';
import { AwarenessLevel } from './snapshotTracker';
import {
  INTENT_INVESTIGATE_MAX_FILES,
  INTENT_SURVEY_DEFAULT_DEPTH,
  INTENT_SURVEY_MAX_DEPTH,
  INTENT_SURVEY_MAX_SHAPED_FILES,
} from '../promptMemory';

registerIntent('intent.understand', resolveUnderstand);
registerIntent('intent.edit', resolveEdit);
registerIntent('intent.edit_multi', resolveEditMulti);
registerIntent('intent.investigate', resolveInvestigate);
registerIntent('intent.diagnose', resolveDiagnose);
registerIntent('intent.survey', resolveSurvey);
registerIntent('intent.refactor', resolveRefactor);
registerIntent('intent.create', resolveCreate);
registerIntent('intent.test', resolveTest);
registerIntent('intent.search_replace', resolveSearchReplace);
registerIntent('intent.extract', resolveExtract);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyContext(overrides?: Partial<IntentContext>): IntentContext {
  return {
    staged: new Map(),
    pinned: new Set(),
    pinnedSources: new Set(),
    bbKeys: new Map(),
    awareness: new Map(),
    priorOutputs: new Map(),
    ...overrides,
  };
}

function stagedContext(files: string[]): IntentContext {
  const staged = new Map<string, { source?: string; tokens: number }>();
  for (const f of files) {
    staged.set(`h:${f.replace(/[/\\]/g, '_')}`, { source: f, tokens: 100 });
  }
  return emptyContext({ staged });
}

function pinnedContext(files: string[]): IntentContext {
  const pinnedSources = new Set(files.map(f => f.replace(/\\/g, '/').toLowerCase()));
  return emptyContext({ pinnedSources, pinned: new Set(['hash1']) });
}

function awareContext(files: string[], level: AwarenessLevel, maxLine = 100): IntentContext {
  const awareness = new Map<string, { snapshotHash: string; level: number; readRegions: Array<{ start: number; end: number }> }>();
  for (const f of files) {
    awareness.set(f.replace(/\\/g, '/').toLowerCase(), {
      snapshotHash: 'snap123',
      level,
      readRegions: [{ start: 1, end: maxLine }],
    });
  }
  return emptyContext({ awareness });
}

function fullContext(files: string[]): IntentContext {
  const staged = new Map<string, { source?: string; tokens: number }>();
  const pinnedSources = new Set<string>();
  const bbKeys = new Map<string, { tokens: number; derivedFrom?: string[] }>();
  const awareness = new Map<string, { snapshotHash: string; level: number; readRegions: Array<{ start: number; end: number }> }>();

  for (const f of files) {
    const norm = f.replace(/\\/g, '/').toLowerCase();
    staged.set(`h:${f.replace(/[/\\]/g, '_')}`, { source: f, tokens: 100 });
    pinnedSources.add(norm);
    bbKeys.set(`deps:${f}`, { tokens: 50 });
    awareness.set(norm, { snapshotHash: 'snap', level: AwarenessLevel.CANONICAL, readRegions: [{ start: 1, end: 200 }] });
  }

  return emptyContext({ staged, pinnedSources, pinned: new Set(['hash1']), bbKeys, awareness });
}

function mkChunkEntry(partial: Partial<ChunkEntry> & Pick<ChunkEntry, 'type' | 'content' | 'tokens'>): ChunkEntry {
  return {
    hash: 'abcd1234ef567890abcd1234ef567890',
    shortHash: 'abcd12',
    lastAccessed: Date.now(),
    ...partial,
  };
}

function mockContextStore(chunks: Map<string, ChunkEntry>): () => ContextStoreApi {
  return () =>
    ({
      getStagedEntries: () => new Map(),
      chunks,
      listBlackboardEntries: () => [],
      getBlackboardEntryWithMeta: () => null,
      getAwarenessCache: () => new Map(),
    }) as ContextStoreApi;
}

function mockContextStoreWithBb(
  chunks: Map<string, ChunkEntry>,
  bbList: Array<{ key: string; preview: string; tokens: number; state: string }>,
): () => ContextStoreApi {
  return () =>
    ({
      getStagedEntries: () => new Map(),
      chunks,
      listBlackboardEntries: () => bbList,
      getBlackboardEntryWithMeta: (key: string) =>
        bbList.some(e => e.key === key)
          ? { content: 'x', kind: 'general', state: 'active', derivedFrom: ['src/z.ts'] }
          : null,
      getAwarenessCache: () => new Map(),
    }) as ContextStoreApi;
}

// ---------------------------------------------------------------------------
// buildIntentContext — chunk-derived bbKeys (mirrors analyze.* addChunk storage)
// ---------------------------------------------------------------------------

describe('buildIntentContext chunk-derived bbKeys', () => {
  it('maps deps chunk source to deps: keys per file (comma-separated)', () => {
    const chunks = new Map<string, ChunkEntry>();
    chunks.set('h1', mkChunkEntry({
      type: 'deps',
      source: 'src/a.ts, src/b.ts',
      content: '{}',
      tokens: 40,
    }));
    const ctx = buildIntentContext(mockContextStore(chunks), new Map());
    expect(ctx.bbKeys.has('deps:src/a.ts')).toBe(true);
    expect(ctx.bbKeys.has('deps:src/b.ts')).toBe(true);
  });

  it('does not overwrite existing BB keys with chunk-derived entries', () => {
    const chunks = new Map<string, ChunkEntry>();
    chunks.set('h1', mkChunkEntry({
      type: 'deps',
      source: 'src/a.ts',
      content: '{}',
      tokens: 10,
    }));
    const ctx = buildIntentContext(mockContextStoreWithBb(chunks, [
      { key: 'deps:src/a.ts', preview: 'x', tokens: 999, state: 'active' },
    ]), new Map());
    expect(ctx.bbKeys.get('deps:src/a.ts')?.tokens).toBe(999);
    expect(ctx.bbKeys.get('deps:src/a.ts')?.derivedFrom).toEqual(['src/z.ts']);
  });

  it('maps analysis chunk with file path source to extract_plan: key', () => {
    const chunks = new Map<string, ChunkEntry>();
    chunks.set('h1', mkChunkEntry({
      type: 'analysis',
      source: 'packages/foo/src/bar.ts',
      content: '{}',
      tokens: 25,
    }));
    const ctx = buildIntentContext(mockContextStore(chunks), new Map());
    expect(ctx.bbKeys.has('extract_plan:packages/foo/src/bar.ts')).toBe(true);
  });

  it('does not treat literal analysis sources as file paths', () => {
    const chunks = new Map<string, ChunkEntry>();
    chunks.set('h1', mkChunkEntry({
      type: 'analysis',
      source: 'call_hierarchy',
      content: '{}',
      tokens: 15,
    }));
    const ctx = buildIntentContext(mockContextStore(chunks), new Map());
    expect([...ctx.bbKeys.keys()].some(k => k.startsWith('extract_plan:'))).toBe(false);
  });
});

describe('intent resolvers with chunk-only context (no manual bbKeys)', () => {
  it('intent.understand skips analyze.deps when deps chunk exists for that path', () => {
    const chunks = new Map<string, ChunkEntry>();
    chunks.set('h1', mkChunkEntry({
      type: 'deps',
      source: 'src/auth.ts',
      content: '{}',
      tokens: 12,
    }));
    const intentCtx = buildIntentContext(mockContextStore(chunks), new Map());
    const result = resolveUnderstand({ file_paths: ['src/auth.ts'], _intentId: 'u1' }, intentCtx);
    expect(result.steps.map(s => s.use)).not.toContain('analyze.deps');
  });

  it('intent.refactor skips analyze.extract_plan when analysis chunk source matches file_path', () => {
    const chunks = new Map<string, ChunkEntry>();
    chunks.set('h1', mkChunkEntry({
      type: 'analysis',
      source: 'src/lib.ts',
      content: '{}',
      tokens: 30,
    }));
    const intentCtx = buildIntentContext(mockContextStore(chunks), new Map());
    const result = resolveRefactor({ file_path: 'src/lib.ts', _intentId: 'r1' }, intentCtx);
    expect(result.steps.map(s => s.use)).not.toContain('analyze.extract_plan');
  });
});

// ---------------------------------------------------------------------------
// intent.understand — state-awareness tests
// ---------------------------------------------------------------------------

describe('intent.understand resolver', () => {
  const params = { file_paths: ['src/auth.ts'], _intentId: 'u1' };

  it('ps string → same expansion as file_paths', () => {
    const withPs = resolveUnderstand({ ps: 'src/auth.ts', _intentId: 'u1' }, emptyContext());
    const withFp = resolveUnderstand({ file_paths: ['src/auth.ts'], _intentId: 'u1' }, emptyContext());
    expect(withPs.steps.map(s => s.use)).toEqual(withFp.steps.map(s => s.use));
    expect(withPs.steps.length).toBe(4);
  });

  it('empty context → full expansion (4 steps)', () => {
    const result = resolveUnderstand(params, emptyContext());
    expect(result.steps.length).toBe(4);
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.shaped');
    expect(ops).toContain('analyze.deps');
    expect(ops).toContain('session.stage');
    expect(ops).toContain('session.pin');
  });

  it('staged file → skips read + stage + pin, keeps deps', () => {
    const ctx = stagedContext(['src/auth.ts']);
    const result = resolveUnderstand(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.shaped');
    expect(ops).not.toContain('session.stage');
    expect(ops).not.toContain('session.pin');
    expect(ops).toContain('analyze.deps');
    expect(result.steps.length).toBe(1);
  });

  it('pinned file → skips session.pin but keeps read + stage', () => {
    const ctx = pinnedContext(['src/auth.ts']);
    const result = resolveUnderstand(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.shaped');
    expect(ops).toContain('session.stage');
    expect(ops).not.toContain('session.pin');
  });

  it('deps in BB → skips analyze.deps', () => {
    const bbKeys = new Map([['deps:src/auth.ts', { tokens: 50 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveUnderstand(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('analyze.deps');
  });

  it('awareness >= SHAPED → skips read + stage + pin', () => {
    const ctx = awareContext(['src/auth.ts'], AwarenessLevel.SHAPED);
    const result = resolveUnderstand(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.shaped');
    expect(ops).not.toContain('session.stage');
    expect(ops).not.toContain('session.pin');
    expect(ops).toContain('analyze.deps');
  });

  it('everything cached → zero expansion', () => {
    const ctx = fullContext(['src/auth.ts']);
    const result = resolveUnderstand(params, ctx);
    expect(result.steps.length).toBe(0);
  });

  it('force:true → full expansion regardless of context', () => {
    const ctx = fullContext(['src/auth.ts']);
    const result = resolveUnderstand({ ...params, force: true }, ctx);
    expect(result.steps.length).toBeGreaterThanOrEqual(4);
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.shaped');
    expect(ops).toContain('analyze.deps');
    expect(ops).toContain('session.stage');
    expect(ops).toContain('session.pin');
    expect(ops).toContain('analyze.extract_plan');
  });

  it('large file → adds analyze.extract_plan', () => {
    const ctx = awareContext(['src/auth.ts'], AwarenessLevel.SHAPED, 800);
    const result = resolveUnderstand(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('analyze.extract_plan');
  });

  it('small file → no analyze.extract_plan', () => {
    const ctx = awareContext(['src/auth.ts'], AwarenessLevel.SHAPED, 200);
    const result = resolveUnderstand(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('analyze.extract_plan');
  });

  it('multiple files → steps for each file', () => {
    const multiParams = { file_paths: ['src/a.ts', 'src/b.ts'], _intentId: 'u1' };
    const result = resolveUnderstand(multiParams, emptyContext());
    expect(result.steps.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Ref wiring tests
// ---------------------------------------------------------------------------

describe('intent.understand ref wiring', () => {
  it('session.stage wires from_step to read.shaped refs', () => {
    const params = { file_paths: ['src/auth.ts'], _intentId: 'u1' };
    const result = resolveUnderstand(params, emptyContext());
    const stageStep = result.steps.find(s => s.use === 'session.stage');
    expect(stageStep).toBeDefined();
    expect(stageStep!.in).toBeDefined();
    const hashesIn = stageStep!.in!.hashes as { from_step: string; path: string };
    expect(hashesIn.from_step).toBe('u1__read_shaped_0');
    expect(hashesIn.path).toBe('refs');
  });

  it('session.pin wires from_step to read.shaped refs', () => {
    const params = { file_paths: ['src/auth.ts'], _intentId: 'u1' };
    const result = resolveUnderstand(params, emptyContext());
    const pinStep = result.steps.find(s => s.use === 'session.pin');
    expect(pinStep).toBeDefined();
    expect(pinStep!.in).toBeDefined();
    const hashesIn = pinStep!.in!.hashes as { from_step: string; path: string };
    expect(hashesIn.from_step).toBe('u1__read_shaped_0');
    expect(hashesIn.path).toBe('refs');
  });
});

// ---------------------------------------------------------------------------
// resolveIntents integration
// ---------------------------------------------------------------------------

describe('resolveIntents', () => {
  it('passes non-intent steps through unchanged', () => {
    const steps = [
      { id: 's1', use: 'search.code' as const, with: { queries: ['auth'] } },
    ];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded).toEqual(steps);
    expect(result.metrics).toHaveLength(0);
  });

  it('expands intent.understand into primitives', () => {
    const steps = [
      { id: 'u1', use: 'intent.understand' as const, with: { file_paths: ['src/a.ts'], _intentId: 'u1' } },
    ];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded.length).toBeGreaterThan(0);
    expect(result.expanded.every(s => !s.use.startsWith('intent.'))).toBe(true);
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].intentName).toBe('intent.understand');
  });

  it('mixed batch: non-intent + intent steps', () => {
    const steps = [
      { id: 's1', use: 'search.code' as const, with: { queries: ['auth'] } },
      { id: 'u1', use: 'intent.understand' as const, with: { file_paths: ['src/a.ts'], _intentId: 'u1' } },
      { id: 's2', use: 'verify.build' as const },
    ];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded[0].id).toBe('s1');
    expect(result.expanded[result.expanded.length - 1].id).toBe('s2');
    expect(result.expanded.length).toBeGreaterThan(3);
  });

  it('metrics track skipped steps', () => {
    const steps = [
      { id: 'u1', use: 'intent.understand' as const, with: { file_paths: ['src/a.ts'], _intentId: 'u1' } },
    ];
    const ctx = fullContext(['src/a.ts']);
    const result = resolveIntents(steps, ctx);
    expect(result.metrics[0].emittedSteps).toBe(0);
    expect(result.metrics[0].skippedSteps).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe('normalizeIntentFilePaths', () => {
  it('accepts ps string (file_paths shorthand)', () => {
    expect(normalizeIntentFilePaths({ ps: 'src/a.ts' })).toEqual(['src/a.ts']);
  });

  it('accepts ps array', () => {
    expect(normalizeIntentFilePaths({ ps: ['src/a.ts', 'src/b.ts'] })).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('prefers ps over file_paths when both present', () => {
    expect(normalizeIntentFilePaths({ ps: 'first.ts', file_paths: ['second.ts'] })).toEqual(['first.ts']);
  });

  it('falls back to file_paths and file', () => {
    expect(normalizeIntentFilePaths({ file_paths: ['x.ts'] })).toEqual(['x.ts']);
    expect(normalizeIntentFilePaths({ file: 'y.ts' })).toEqual(['y.ts']);
  });
});

describe('intent helpers', () => {
  it('makeStepId formats correctly', () => {
    expect(makeStepId('u1', 'read_shaped', 0)).toBe('u1__read_shaped_0');
    expect(makeStepId('u1', 'pin')).toBe('u1__pin');
  });

  it('isFileStaged matches by normalized source', () => {
    const staged = new Map([['h:abc', { source: 'src/Auth.ts', tokens: 100 }]]);
    expect(isFileStaged(staged, 'src/Auth.ts')).toBe(true);
    expect(isFileStaged(staged, 'src/auth.ts')).toBe(true);
    expect(isFileStaged(staged, 'src\\Auth.ts')).toBe(true);
    expect(isFileStaged(staged, 'src/other.ts')).toBe(false);
  });

  it('isFilePinned matches by normalized source', () => {
    const pinnedSources = new Set(['src/auth.ts']);
    expect(isFilePinned(pinnedSources, 'src/auth.ts')).toBe(true);
    expect(isFilePinned(pinnedSources, 'src/Auth.ts')).toBe(true);
    expect(isFilePinned(pinnedSources, 'src\\auth.ts')).toBe(true);
    expect(isFilePinned(pinnedSources, 'src/other.ts')).toBe(false);
  });

  it('getFileAwareness returns entry by normalized path', () => {
    const awareness = new Map([['src/auth.ts', { snapshotHash: 'abc', level: 2, readRegions: [{ start: 1, end: 100 }] }]]);
    expect(getFileAwareness(awareness, 'src/auth.ts')).toBeDefined();
    expect(getFileAwareness(awareness, 'SRC/AUTH.TS')).toBeDefined();
    expect(getFileAwareness(awareness, 'src/other.ts')).toBeUndefined();
  });

  it('estimateFileLines returns max region end', () => {
    const awareness = new Map([['src/auth.ts', { snapshotHash: 'abc', level: 2, readRegions: [{ start: 1, end: 100 }, { start: 200, end: 600 }] }]]);
    expect(estimateFileLines(awareness, 'src/auth.ts')).toBe(600);
  });

  it('estimateFileLines returns 0 for unknown file', () => {
    expect(estimateFileLines(new Map(), 'unknown.ts')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// intent.edit — state-awareness + conditional retry
// ---------------------------------------------------------------------------

describe('intent.edit resolver', () => {
  const params = { file_path: 'src/auth.ts', line_edits: [{ line: 10, action: 'replace', content: 'x' }], _intentId: 'e1' };

  it('empty context → emits read + edit + retry + verify', () => {
    const result = resolveEdit(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.lines');
    expect(ops).toContain('change.edit');
    expect(ops).toContain('verify.build');
    expect(result.steps.length).toBeGreaterThanOrEqual(4);
  });

  it('SHAPED awareness → skips read', () => {
    const awareness = new Map([['src/auth.ts', { snapshotHash: 'snap', level: AwarenessLevel.SHAPED, readRegions: [{ start: 1, end: 50 }] }]]);
    const ctx = emptyContext({ awareness });
    const result = resolveEdit(params, ctx);
    const readSteps = result.steps.filter(s => (s.use === 'read.lines' || s.use === 'read.shaped') && !s.if);
    expect(readSteps.length).toBe(0);
  });

  it('staged file → skips read', () => {
    const ctx = stagedContext(['src/auth.ts']);
    const result = resolveEdit(params, ctx);
    const readSteps = result.steps.filter(s => (s.use === 'read.lines' || s.use === 'read.shaped') && !s.if);
    expect(readSteps.length).toBe(0);
  });

  it('emits conditional retry steps only for recoverable edit error classes', () => {
    const result = resolveEdit(params, emptyContext());
    const retryRead = result.steps.find(s => s.id === 'e1__retry_read');
    const retryEdit = result.steps.find(s => s.id === 'e1__retry_edit');
    expect(retryRead).toBeDefined();
    expect(retryEdit).toBeDefined();
    expect(retryRead!.if).toMatchObject({
      step_error_class_in: { step_id: 'e1__edit' },
    });
    expect(retryEdit!.if).toMatchObject({
      step_error_class_in: { step_id: 'e1__edit' },
    });
    expect(JSON.stringify(retryEdit!.if)).not.toContain('syntax_error_after_edit');
  });

  it('verify:false → no verify step', () => {
    const result = resolveEdit({ ...params, verify: false }, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('verify.build');
  });
});

// ---------------------------------------------------------------------------
// intent.investigate — BB-awareness
// ---------------------------------------------------------------------------

describe('intent.investigate resolver', () => {
  const params = { query: 'authentication flow', _intentId: 'inv1' };

  it('empty context → emits search + read.shaped(sig) + stage + bb.write', () => {
    const result = resolveInvestigate(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('search.code');
    expect(ops).toContain('read.shaped');
    expect(ops).not.toContain('read.context');
    expect(ops).toContain('session.stage');
    expect(ops).toContain('session.bb.write');
    const searchStep = result.steps.find(s => s.use === 'search.code');
    expect(searchStep?.with?.max_file_paths).toBe(INTENT_INVESTIGATE_MAX_FILES);
    const readStep = result.steps.find(s => s.use === 'read.shaped');
    expect(readStep?.with?.shape).toBe('sig');
    expect(readStep?.with?.max_files).toBe(INTENT_INVESTIGATE_MAX_FILES);
  });

  it('BB has cached results → skips search and read', () => {
    const bbKeys = new Map([['investigate:authentication_flow', { tokens: 100 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveInvestigate(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('search.code');
    expect(ops).not.toContain('read.shaped');
  });

  it('force:true → full expansion even with BB cache', () => {
    const bbKeys = new Map([['investigate:authentication_flow', { tokens: 100 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveInvestigate({ ...params, force: true }, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('search.code');
  });

  it('read.shaped wires from_step to search results', () => {
    const result = resolveInvestigate(params, emptyContext());
    const readStep = result.steps.find(s => s.use === 'read.shaped');
    expect(readStep?.in?.file_paths).toEqual({ from_step: 'inv1__search', path: 'content.file_paths' });
  });

  it('read.shaped + bb_write gate on step_content_array_nonempty (zero-hit searches skip cleanly)', () => {
    const result = resolveInvestigate(params, emptyContext());
    const readStep = result.steps.find(s => s.use === 'read.shaped');
    expect(readStep?.if).toEqual({
      step_content_array_nonempty: { step_id: 'inv1__search', path: 'file_paths' },
    });
    const bbStep = result.steps.find(s => s.use === 'session.bb.write');
    expect(bbStep?.if).toEqual({
      step_content_array_nonempty: { step_id: 'inv1__search', path: 'file_paths' },
    });
  });
});

// ---------------------------------------------------------------------------
// intent.survey — tree caching
// ---------------------------------------------------------------------------

describe('intent.survey resolver', () => {
  const params = { directory: 'src/services', _intentId: 'sv1' };

  it('empty context → emits tree read + sig read + stage + bb.write', () => {
    const result = resolveSurvey(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.context');
    expect(ops).toContain('read.shaped');
    expect(ops).toContain('session.stage');
    expect(ops).toContain('session.bb.write');
    const treeStep = result.steps.find(s => s.use === 'read.context');
    expect(treeStep?.with).toMatchObject({
      type: 'tree',
      file_paths: ['src/services'],
      depth: INTENT_SURVEY_DEFAULT_DEPTH,
    });
    const sigStep = result.steps.find(s => s.use === 'read.shaped');
    expect(sigStep?.with?.max_files).toBe(INTENT_SURVEY_MAX_SHAPED_FILES);
  });

  it('clamps depth to INTENT_SURVEY_MAX_DEPTH', () => {
    const result = resolveSurvey({ ...params, depth: 99 }, emptyContext());
    const treeStep = result.steps.find(s => s.use === 'read.context');
    expect(treeStep?.with?.depth).toBe(INTENT_SURVEY_MAX_DEPTH);
  });

  it('tree in BB → zero expansion', () => {
    const bbKeys = new Map([['tree:src/services', { tokens: 200 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveSurvey(params, ctx);
    expect(result.steps.length).toBe(0);
  });

  it('force:true → full expansion even with BB cache', () => {
    const bbKeys = new Map([['tree:src/services', { tokens: 200 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveSurvey({ ...params, force: true }, ctx);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('force:true → prepends session.bb.delete to invalidate cached tree key', () => {
    const bbKeys = new Map([['tree:src/services', { tokens: 200 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveSurvey({ ...params, force: true }, ctx);
    expect(result.steps[0]?.use).toBe('session.bb.delete');
    expect(result.steps[0]?.with).toEqual({ keys: ['tree:src/services'] });
  });
});

// ---------------------------------------------------------------------------
// intent.refactor — full chain
// ---------------------------------------------------------------------------

describe('intent.refactor resolver', () => {
  const params = { file_path: 'src/lib.rs', symbol_names: ['dispatch'], target_file: 'src/dispatch.rs', _intentId: 'rf1' };

  it('empty context → emits read + pin + deps + extract + refactor + verify', () => {
    const result = resolveRefactor(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.shaped');
    expect(ops).toContain('session.pin');
    expect(ops).toContain('analyze.deps');
    expect(ops).toContain('analyze.extract_plan');
    expect(ops).toContain('change.refactor');
    expect(ops).toContain('verify.build');
  });

  it('pinned file → skips read and pin', () => {
    const pinnedSources = new Set(['src/lib.rs']);
    const awareness = new Map([['src/lib.rs', { snapshotHash: 'snap', level: AwarenessLevel.SHAPED, readRegions: [{ start: 1, end: 100 }] }]]);
    const ctx = emptyContext({ pinnedSources, pinned: new Set(['h1']), awareness });
    const result = resolveRefactor(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.shaped');
    expect(ops).not.toContain('session.pin');
  });

  it('deps + extract_plan in BB → skips analysis steps', () => {
    const bbKeys = new Map([
      ['deps:src/lib.rs', { tokens: 50 }],
      ['extract_plan:src/lib.rs', { tokens: 100 }],
    ]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveRefactor(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('analyze.deps');
    expect(ops).not.toContain('analyze.extract_plan');
    expect(ops).toContain('change.refactor');
    expect(ops).toContain('verify.build');
  });

  it('verify.build has conditional on refactor success', () => {
    const result = resolveRefactor(params, emptyContext());
    const verifyStep = result.steps.find(s => s.use === 'verify.build');
    expect(verifyStep?.if).toEqual({ step_ok: 'rf1__refactor' });
  });

  it('strategy rename maps extract_plan to by_cluster (rename passes through to change.refactor)', () => {
    const result = resolveRefactor({ ...params, strategy: 'rename' }, emptyContext());
    const extractStep = result.steps.find(s => s.use === 'analyze.extract_plan');
    expect(extractStep?.with?.strategy).toBe('by_cluster');
    const refactorStep = result.steps.find(s => s.use === 'change.refactor');
    expect(refactorStep?.with?.extractions).toEqual([
      { symbols: ['dispatch'], target_file: 'src/dispatch.rs' },
    ]);
  });

  it('maps explicit symbol extraction to HPP-compatible execute params', () => {
    const result = resolveRefactor(params, emptyContext());
    const refactorStep = result.steps.find(s => s.use === 'change.refactor');
    expect(refactorStep?.with).toMatchObject({
      action: 'execute',
      source_file: 'src/lib.rs',
      extractions: [{ symbols: ['dispatch'], target_file: 'src/dispatch.rs' }],
    });
    expect(refactorStep?.with?.file_paths).toBeUndefined();
    expect(refactorStep?.with?.strategy).toBeUndefined();
  });

  it('does not emit vacuous HPP execute when target_file is missing', () => {
    const result = resolveRefactor(
      { file_path: 'src/lib.rs', symbol_names: ['dispatch'], _intentId: 'rf_missing' },
      emptyContext(),
    );
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('change.refactor');
    expect(ops).toContain('session.emit');
    const emitStep = result.steps.find(s => s.use === 'session.emit');
    expect(emitStep?.with?.content).toContain('no HPP execute step was emitted');
  });
});

// ---------------------------------------------------------------------------
// Metrics tracking
// ---------------------------------------------------------------------------

describe('intent metrics', () => {
  it('tracks steps skipped for understand', () => {
    const steps = [
      { id: 'u1', use: 'intent.understand' as const, with: { file_paths: ['src/a.ts'], _intentId: 'u1' } },
    ];
    const result = resolveIntents(steps, emptyContext());
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].intentName).toBe('intent.understand');
    expect(result.metrics[0].totalPossibleSteps).toBe(4);
    expect(result.metrics[0].emittedSteps).toBe(4);
    expect(result.metrics[0].skippedSteps).toBe(0);
  });

  it('tracks steps skipped when fully cached', () => {
    const steps = [
      { id: 'u1', use: 'intent.understand' as const, with: { file_paths: ['src/a.ts'], _intentId: 'u1' } },
    ];
    const ctx = fullContext(['src/a.ts']);
    const result = resolveIntents(steps, ctx);
    expect(result.metrics[0].emittedSteps).toBe(0);
    expect(result.metrics[0].skippedSteps).toBe(4);
  });

  it('tracks lookahead steps', () => {
    const steps = [
      { id: 'u1', use: 'intent.understand' as const, with: { file_paths: ['src/a.ts'], _intentId: 'u1' } },
    ];
    const result = resolveIntents(steps, emptyContext());
    expect(result.metrics[0].lookaheadSteps).toBe(result.lookahead.length);
  });

  it('multiple intents produce multiple metrics', () => {
    const steps = [
      { id: 'u1', use: 'intent.understand' as const, with: { file_paths: ['src/a.ts'], _intentId: 'u1' } },
      { id: 'e1', use: 'intent.edit' as const, with: { file_path: 'src/a.ts', line_edits: [], _intentId: 'e1' } },
    ];
    const result = resolveIntents(steps, emptyContext());
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics[0].intentName).toBe('intent.understand');
    expect(result.metrics[1].intentName).toBe('intent.edit');
  });
});

// ---------------------------------------------------------------------------
// intent.edit_multi — multi-file edits with single verify
// ---------------------------------------------------------------------------

describe('intent.edit_multi resolver', () => {
  const params = {
    edits: [
      { file_path: 'src/a.ts', line_edits: [{ line: 10, action: 'replace', content: 'x' }] },
      { file_path: 'src/b.ts', line_edits: [{ line: 20, action: 'replace', end_line: 21, content: 'y' }] },
    ],
    _intentId: 'em1',
  };

  it('empty context → emits read + edit + retry per file + single verify', () => {
    const result = resolveEditMulti(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    const unconditionalReads = result.steps.filter(s => s.use === 'read.lines' && !s.if);
    expect(unconditionalReads.length).toBe(2);
    expect(ops.filter(o => o === 'change.edit').length).toBe(4);
    expect(ops.filter(o => o === 'verify.build').length).toBe(1);
  });

  it('staged files → skips reads', () => {
    const ctx = stagedContext(['src/a.ts', 'src/b.ts']);
    const result = resolveEditMulti(params, ctx);
    const unconditionalReads = result.steps.filter(
      s => (s.use === 'read.lines' || s.use === 'read.shaped') && !s.if,
    );
    expect(unconditionalReads.length).toBe(0);
  });

  it('verify uses step_ok on last edit for multiple files', () => {
    const result = resolveEditMulti(params, emptyContext());
    const verifyStep = result.steps.find(s => s.use === 'verify.build');
    expect(verifyStep).toBeDefined();
    expect(verifyStep!.if).toEqual({ step_ok: 'em1__edit_1' });
  });

  it('single file → verify uses step_ok on that edit', () => {
    const singleParams = {
      edits: [{ file_path: 'src/a.ts', line_edits: [{ line: 5, action: 'replace', content: 'z' }] }],
      _intentId: 'em2',
    };
    const result = resolveEditMulti(singleParams, emptyContext());
    const verifyStep = result.steps.find(s => s.use === 'verify.build');
    expect(verifyStep!.if).toEqual({ step_ok: 'em2__edit_0' });
  });

  it('verify:false → no verify step', () => {
    const result = resolveEditMulti({ ...params, verify: false }, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('verify.build');
  });

  it('emits conditional retry steps per file', () => {
    const result = resolveEditMulti(params, emptyContext());
    const retryReads = result.steps.filter(s => s.id.includes('retry_read'));
    const retryEdits = result.steps.filter(s => s.id.includes('retry_edit'));
    expect(retryReads.length).toBe(2);
    expect(retryEdits.length).toBe(2);
    expect(retryReads[0].if).toEqual({ step_error_class_in: { step_id: 'em1__edit_0', classes: ['anchor_not_found', 'stale_hash', 'range_drifted', 'mixed', 'span_out_of_range', 'anchor_mismatch_after_refresh'] } });
    expect(retryReads[1].if).toEqual({ step_error_class_in: { step_id: 'em1__edit_1', classes: ['anchor_not_found', 'stale_hash', 'range_drifted', 'mixed', 'span_out_of_range', 'anchor_mismatch_after_refresh'] } });
  });

  it('force:true → reads even when staged', () => {
    const ctx = stagedContext(['src/a.ts', 'src/b.ts']);
    const result = resolveEditMulti({ ...params, force: true }, ctx);
    const unconditionalReads = result.steps.filter(
      s => (s.use === 'read.lines' || s.use === 'read.shaped') && !s.if,
    );
    expect(unconditionalReads.length).toBe(2);
  });

  it('empty edits → no steps except no verify', () => {
    const result = resolveEditMulti({ edits: [], _intentId: 'em3' }, emptyContext());
    expect(result.steps.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// intent.diagnose — issue discovery
// ---------------------------------------------------------------------------

describe('intent.diagnose resolver', () => {
  const params = { file_paths: ['src/auth.ts'], query: 'type errors', _intentId: 'dg1' };

  it('empty context → emits search.issues + read + impact + stage + bb.write', () => {
    const result = resolveDiagnose(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('search.issues');
    expect(ops).toContain('read.context');
    expect(ops).toContain('analyze.impact');
    expect(ops).toContain('session.stage');
    expect(ops).toContain('session.bb.write');
    expect(result.steps.length).toBe(5);
  });

  it('does NOT emit any change.* steps', () => {
    const result = resolveDiagnose(params, emptyContext());
    const changeSteps = result.steps.filter(s => s.use.startsWith('change.'));
    expect(changeSteps.length).toBe(0);
  });

  it('BB cached → zero expansion', () => {
    const bbKeys = new Map([['diagnose:type_errors', { tokens: 100 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveDiagnose(params, ctx);
    expect(result.steps.length).toBe(0);
  });

  it('force:true → full expansion even with BB cache', () => {
    const bbKeys = new Map([['diagnose:type_errors', { tokens: 100 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveDiagnose({ ...params, force: true }, ctx);
    expect(result.steps.length).toBeGreaterThan(0);
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('search.issues');
  });

  it('staged files → skips read.context', () => {
    const ctx = stagedContext(['src/auth.ts']);
    const result = resolveDiagnose(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.context');
  });

  it('no file_paths → read.context wires from search results', () => {
    const noFileParams = { query: 'type errors', _intentId: 'dg2' };
    const result = resolveDiagnose(noFileParams, emptyContext());
    const readStep = result.steps.find(s => s.use === 'read.context');
    expect(readStep?.in?.file_paths).toEqual({ from_step: 'dg2__search_issues', path: 'content.file_paths' });
  });

  it('severity param is forwarded to search.issues', () => {
    const sevParams = { ...params, severity: 'high' };
    const result = resolveDiagnose(sevParams, emptyContext());
    const searchStep = result.steps.find(s => s.use === 'search.issues');
    expect(searchStep!.with!.severity_filter).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// intent.create — new file with dep context
// ---------------------------------------------------------------------------

describe('intent.create resolver', () => {
  const params = {
    target_path: 'src/utils/helper.ts',
    content: 'export function helper() { return 1; }',
    ref_files: ['src/types.ts', 'src/config.ts'],
    _intentId: 'cr1',
  };

  it('empty context → emits ref reads + create + verify', () => {
    const result = resolveCreate(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops.filter(o => o === 'read.shaped').length).toBe(2);
    expect(ops).toContain('change.create');
    expect(ops).toContain('verify.typecheck');
  });

  it('staged ref_files → skips reads', () => {
    const ctx = stagedContext(['src/types.ts', 'src/config.ts']);
    const result = resolveCreate(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.shaped');
    expect(ops).toContain('change.create');
  });

  it('aware ref_files → skips reads', () => {
    const ctx = awareContext(['src/types.ts', 'src/config.ts'], AwarenessLevel.SHAPED);
    const result = resolveCreate(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.shaped');
  });

  it('no ref_files → just create + verify', () => {
    const noRefParams = { target_path: 'src/new.ts', content: 'export const x = 1;', _intentId: 'cr2' };
    const result = resolveCreate(noRefParams, emptyContext());
    expect(result.steps.length).toBe(2);
    const ops = result.steps.map(s => s.use);
    expect(ops).toEqual(['change.create', 'verify.typecheck']);
  });

  it('verify:false → no verify step', () => {
    const result = resolveCreate({ ...params, verify: false }, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('verify.typecheck');
  });

  it('create step has correct target_path and content', () => {
    const result = resolveCreate(params, emptyContext());
    const createStep = result.steps.find(s => s.use === 'change.create');
    expect(createStep!.with!.creates).toEqual([{ path: 'src/utils/helper.ts', content: 'export function helper() { return 1; }' }]);
  });

  it('verify conditioned on create success', () => {
    const result = resolveCreate(params, emptyContext());
    const verifyStep = result.steps.find(s => s.use === 'verify.typecheck');
    expect(verifyStep!.if).toEqual({ step_ok: 'cr1__create' });
  });

  it('force:true → reads even when staged', () => {
    const ctx = stagedContext(['src/types.ts', 'src/config.ts']);
    const result = resolveCreate({ ...params, force: true }, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops.filter(o => o === 'read.shaped').length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// intent.test — test context preparation
// ---------------------------------------------------------------------------

describe('intent.test resolver', () => {
  const params = { source_file: 'src/auth.ts', test_file: 'src/auth.test.ts', _intentId: 'tst1' };

  it('empty context → emits source read + test read + stage + bb.write', () => {
    const result = resolveTest(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.shaped');
    expect(ops).toContain('read.context');
    expect(ops).toContain('session.stage');
    expect(ops).toContain('session.bb.write');
  });

  it('does NOT emit any change.* steps', () => {
    const result = resolveTest(params, emptyContext());
    const changeSteps = result.steps.filter(s => s.use.startsWith('change.'));
    expect(changeSteps.length).toBe(0);
  });

  it('BB cached → zero expansion', () => {
    const bbKeys = new Map([['test_context:src/auth.ts', { tokens: 100 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveTest(params, ctx);
    expect(result.steps.length).toBe(0);
  });

  it('source staged → skips source read', () => {
    const ctx = stagedContext(['src/auth.ts']);
    const result = resolveTest(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.shaped');
    expect(ops).toContain('read.context');
  });

  it('test file staged → skips test read', () => {
    const ctx = stagedContext(['src/auth.test.ts']);
    const result = resolveTest(params, ctx);
    const readContextSteps = result.steps.filter(s => s.use === 'read.context');
    expect(readContextSteps.length).toBe(0);
  });

  it('no test_file → skips test read', () => {
    const noTestParams = { source_file: 'src/auth.ts', _intentId: 'tst2' };
    const result = resolveTest(noTestParams, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.context');
    expect(ops).toContain('read.shaped');
    expect(ops).toContain('session.bb.write');
  });

  it('force:true → full expansion even with BB cache', () => {
    const bbKeys = new Map([['test_context:src/auth.ts', { tokens: 100 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveTest({ ...params, force: true }, ctx);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('no lookahead (context-only intent)', () => {
    const result = resolveTest(params, emptyContext());
    expect(result.prepareNext ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// intent.search_replace — literal find/replace
// ---------------------------------------------------------------------------

describe('intent.search_replace resolver', () => {
  const params = { old_text: 'console.log', new_text: 'logger.info', _intentId: 'sr1' };

  it('empty context → emits search + edit slots + bb.write + verify', () => {
    const result = resolveSearchReplace(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('search.code');
    // Default max_matches is 20 UNIQUE FILES — each slot binds to a deduped
    // hit file via `content.unique_file_paths.${i}`. Combined with
    // replace_all:true, one slot per file handles every occurrence in that
    // file, so the old 50-slot per-hit fan-out is unnecessary.
    expect(ops.filter(o => o === 'change.edit').length).toBe(20);
    expect(ops).toContain('session.bb.write');
    expect(ops).toContain('verify.build');
  });

  it('BB cached → zero expansion', () => {
    const bbKeys = new Map([['search_replace:console.log', { tokens: 50 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveSearchReplace(params, ctx);
    expect(result.steps.length).toBe(0);
  });

  it('max_matches limits edit slots', () => {
    const limitedParams = { ...params, max_matches: 3 };
    const result = resolveSearchReplace(limitedParams, emptyContext());
    const editSteps = result.steps.filter(s => s.use === 'change.edit');
    expect(editSteps.length).toBe(3);
  });

  it('edit slots emit text-replace {old,new} shape bound to unique_file_paths', () => {
    const result = resolveSearchReplace(params, emptyContext());
    const editStep = result.steps.find(s => s.use === 'change.edit');
    // Substring replace — backend verifies `old` exists in the file before
    // writing and replaces only that substring. FTS false positives return
    // `Pattern not found` instead of corrupting the hit line. Binding against
    // `unique_file_paths` dedupes per-file so duplicate hits don't fan out
    // to wasted slots.
    expect(editStep!.with!.edits).toEqual([{ old: 'console.log', new: 'logger.info' }]);
    expect(editStep!.with!.replace_all).toBe(true);
    expect(editStep!.with!.line_edits).toBeUndefined();
    expect(editStep!.in).toEqual({
      file_path: { from_step: 'sr1__search', path: 'content.unique_file_paths.0' },
    });
  });

  it('verify conditioned on search producing unique_file_paths hits', () => {
    const result = resolveSearchReplace(params, emptyContext());
    const verifyStep = result.steps.find(s => s.use === 'verify.build');
    expect(verifyStep!.if).toEqual({
      step_content_array_nonempty: { step_id: 'sr1__search', path: 'unique_file_paths' },
    });
  });

  it('edit slots conditioned on search producing unique_file_paths hits', () => {
    const result = resolveSearchReplace(params, emptyContext());
    const editSteps = result.steps.filter(s => s.use === 'change.edit');
    for (const [index, step] of editSteps.entries()) {
      expect(step.if).toEqual({
        step_content_array_has_index: { step_id: 'sr1__search', path: 'unique_file_paths', index },
      });
    }
  });

  it('file_glob is forwarded to search', () => {
    const globParams = { ...params, file_glob: 'src/**/*.ts' };
    const result = resolveSearchReplace(globParams, emptyContext());
    const searchStep = result.steps.find(s => s.use === 'search.code');
    expect(searchStep!.with!.file_paths).toEqual(['src/**/*.ts']);
  });

  it('search forwards limit and max_file_paths from max_matches', () => {
    const result = resolveSearchReplace({ ...params, max_matches: 5 }, emptyContext());
    const searchStep = result.steps.find(s => s.use === 'search.code');
    expect(searchStep!.with!.queries).toEqual(['console.log']);
    expect(searchStep!.with!.exact_text).toBe('console.log');
    expect(searchStep!.with!.limit).toBe(5);
    expect(searchStep!.with!.max_file_paths).toBe(5);
  });

  it('concrete file_glob sets file_path on with and omits the file_path binding', () => {
    const result = resolveSearchReplace(
      { ...params, file_glob: '_test/edit_test.py' },
      emptyContext(),
    );
    const editSteps = result.steps.filter(s => s.use === 'change.edit');
    expect(editSteps).toHaveLength(1);
    const editStep = editSteps[0];
    expect(editStep!.with!.file_path).toBe('_test/edit_test.py');
    // Concrete path: no binding needed.
    expect(editStep!.in).toBeUndefined();
    expect(editStep!.if).toEqual({
      step_content_array_nonempty: { step_id: 'sr1__search', path: 'unique_file_paths' },
    });
  });

  it('verify:false → no verify step', () => {
    const result = resolveSearchReplace({ ...params, verify: false }, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('verify.build');
  });

  it('force:true → full expansion even with BB cache', () => {
    const bbKeys = new Map([['search_replace:console.log', { tokens: 50 }]]);
    const ctx = emptyContext({ bbKeys });
    const result = resolveSearchReplace({ ...params, force: true }, ctx);
    expect(result.steps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// intent.extract — symbol extraction
// ---------------------------------------------------------------------------

describe('intent.extract resolver', () => {
  const params = { source_file: 'src/lib.rs', symbol_names: ['dispatch'], target_file: 'src/handlers.rs', _intentId: 'ex1' };

  it('empty context → emits read + refactor + verify', () => {
    const result = resolveExtract(params, emptyContext());
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.shaped');
    expect(ops).toContain('change.refactor');
    expect(ops).toContain('verify.build');
    expect(result.steps.length).toBe(3);
  });

  it('pinned source → skips read', () => {
    const pinnedSources = new Set(['src/lib.rs']);
    const awareness = new Map([['src/lib.rs', { snapshotHash: 'snap', level: AwarenessLevel.SHAPED, readRegions: [{ start: 1, end: 100 }] }]]);
    const ctx = emptyContext({ pinnedSources, pinned: new Set(['h1']), awareness });
    const result = resolveExtract(params, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).not.toContain('read.shaped');
    expect(ops).toContain('change.refactor');
  });

  it('refactor has correct params', () => {
    const result = resolveExtract(params, emptyContext());
    const refactorStep = result.steps.find(s => s.use === 'change.refactor');
    expect(refactorStep!.with!.action).toBe('execute');
    expect(refactorStep!.with!.source_file).toBe('src/lib.rs');
    expect(refactorStep!.with!.extractions).toEqual([
      { symbols: ['dispatch'], target_file: 'src/handlers.rs' },
    ]);
  });

  it('resolves file_path and file_paths[0] as source (marshaling)', () => {
    const viaPath = resolveExtract(
      { file_path: 'src/a.rs', symbol_names: ['x'], target_file: 'src/b.rs', _intentId: 'ex2' },
      emptyContext(),
    );
    const readPath = viaPath.steps.find(s => s.use === 'read.shaped');
    expect(readPath?.with?.file_paths).toEqual(['src/a.rs']);
    const viaPs = resolveExtract(
      { file_paths: ['src/a.rs'], symbol_names: ['x'], target_file: 'src/b.rs', _intentId: 'ex3' },
      emptyContext(),
    );
    expect(viaPs.steps.find(s => s.use === 'read.shaped')?.with?.file_paths).toEqual(['src/a.rs']);
  });

  it('verify conditioned on refactor success', () => {
    const result = resolveExtract(params, emptyContext());
    const verifyStep = result.steps.find(s => s.use === 'verify.build');
    expect(verifyStep!.if).toEqual({ step_ok: 'ex1__refactor' });
  });

  it('force:true → reads even when pinned', () => {
    const pinnedSources = new Set(['src/lib.rs']);
    const awareness = new Map([['src/lib.rs', { snapshotHash: 'snap', level: AwarenessLevel.SHAPED, readRegions: [{ start: 1, end: 100 }] }]]);
    const ctx = emptyContext({ pinnedSources, pinned: new Set(['h1']), awareness });
    const result = resolveExtract({ ...params, force: true }, ctx);
    const ops = result.steps.map(s => s.use);
    expect(ops).toContain('read.shaped');
  });
});

// ---------------------------------------------------------------------------
// resolveIntents integration — new intents
// ---------------------------------------------------------------------------

describe('resolveIntents — new intents', () => {
  it('normalizes intent.edit aliases (f, le) before expanding', () => {
    const steps = [{
      id: 'ie_alias',
      use: 'intent.edit' as const,
      with: {
        f: 'src/auth.ts',
        le: [{ line: 10, action: 'replace' as const, content: 'x' }],
      },
    }];
    const result = resolveIntents(steps, emptyContext());
    const editStep = result.expanded.find(s => s.use === 'change.edit' && !s.if);
    expect(editStep?.with?.file_path).toBe('src/auth.ts');
  });

  it('expands intent.edit_multi into primitives', () => {
    const steps = [{
      id: 'em1',
      use: 'intent.edit_multi' as const,
      with: { edits: [{ file_path: 'src/a.ts', line_edits: [] }], _intentId: 'em1' },
    }];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded.length).toBeGreaterThan(0);
    expect(result.expanded.every(s => !s.use.startsWith('intent.'))).toBe(true);
    expect(result.metrics[0].intentName).toBe('intent.edit_multi');
  });

  it('intent.edit_multi nested edits accept f alias per file', () => {
    const steps = [{
      id: 'em_f',
      use: 'intent.edit_multi' as const,
      with: {
        edits: [{ f: 'src/b.ts', line_edits: [{ line: 1, action: 'replace' as const, content: 'z' }] }],
      },
    }];
    const result = resolveIntents(steps, emptyContext());
    const editStep = result.expanded.find(s => s.use === 'change.edit' && !s.if);
    expect(editStep?.with?.file_path).toBe('src/b.ts');
  });

  it('expands intent.diagnose into primitives', () => {
    const steps = [{
      id: 'dg1',
      use: 'intent.diagnose' as const,
      with: { query: 'errors', _intentId: 'dg1' },
    }];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded.length).toBeGreaterThan(0);
    expect(result.expanded.every(s => !s.use.startsWith('intent.'))).toBe(true);
    expect(result.metrics[0].intentName).toBe('intent.diagnose');
  });

  it('expands intent.create into primitives', () => {
    const steps = [{
      id: 'cr1',
      use: 'intent.create' as const,
      with: { target_path: 'src/new.ts', content: 'x', _intentId: 'cr1' },
    }];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded.length).toBeGreaterThan(0);
    expect(result.expanded.every(s => !s.use.startsWith('intent.'))).toBe(true);
    expect(result.metrics[0].intentName).toBe('intent.create');
  });

  it('expands intent.test into primitives', () => {
    const steps = [{
      id: 'tst1',
      use: 'intent.test' as const,
      with: { source_file: 'src/auth.ts', _intentId: 'tst1' },
    }];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded.length).toBeGreaterThan(0);
    expect(result.expanded.every(s => !s.use.startsWith('intent.'))).toBe(true);
    expect(result.metrics[0].intentName).toBe('intent.test');
  });

  it('expands intent.search_replace into primitives', () => {
    const steps = [{
      id: 'sr1',
      use: 'intent.search_replace' as const,
      with: { old_text: 'foo', new_text: 'bar', _intentId: 'sr1' },
    }];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded.length).toBeGreaterThan(0);
    expect(result.expanded.every(s => !s.use.startsWith('intent.'))).toBe(true);
    expect(result.metrics[0].intentName).toBe('intent.search_replace');
  });

  it('intent.search_replace with no old_text or search_query emits only a gate step (session.emit)', () => {
    const steps = [{
      id: 'sr1',
      use: 'intent.search_replace' as const,
      with: { new_text: 'only_new', _intentId: 'sr1' },
    }];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded).toHaveLength(1);
    expect(result.expanded[0].use).toBe('session.emit');
    expect(result.expanded[0].id).toContain('blocked');
  });

  it('expands intent.extract into primitives', () => {
    const steps = [{
      id: 'ex1',
      use: 'intent.extract' as const,
      with: { source_file: 'src/lib.rs', target_file: 'src/handlers.rs', _intentId: 'ex1' },
    }];
    const result = resolveIntents(steps, emptyContext());
    expect(result.expanded.length).toBeGreaterThan(0);
    expect(result.expanded.every(s => !s.use.startsWith('intent.'))).toBe(true);
    expect(result.metrics[0].intentName).toBe('intent.extract');
  });
});
