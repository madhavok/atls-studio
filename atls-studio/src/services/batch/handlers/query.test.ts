import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  handleSearchCode,
  handleSearchSymbol,
  handleSearchMemory,
  handleSearchUsage,
  handleSearchIssues,
  handleSearchPatterns,
  handleSearchSimilar,
  handleAnalyzeDeps,
  handleAnalyzeBlastRadius,
  handleAnalyzeCalls,
  handleAnalyzeStructure,
  handleAnalyzeImpact,
  handleAnalyzeExtractPlan,
} from './query';
import { useRetentionStore } from '../../../stores/retentionStore';
import { useAppStore } from '../../../stores/appStore';

describe('query handlers', () => {
  beforeEach(() => {
    useRetentionStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports search handlers', () => {
    expect(typeof handleSearchCode).toBe('function');
    expect(typeof handleSearchSymbol).toBe('function');
    expect(typeof handleSearchMemory).toBe('function');
  });

  it('handleSearchCode structured content has one path per hit (duplicate files)', async () => {
    const ctx = {
      atlsBatchQuery: vi.fn(async () => ({
        results: [{
          query: 'q',
          results: [
            { file: 'src/a.ts', line: 1 },
            { file: 'src/a.ts', line: 10 },
          ],
        }],
      })),
      store: () => ({
        addChunk: () => 'hash123',
        recordManageOps: () => {},
        recordToolCall: () => {},
        recordBatchRead: () => {},
        recordCoveragePath: () => {},
        recordFileReadSpin: () => null,
        resetFileReadSpin: () => {},
        getPriorReadRanges: () => [],
        forwardStagedHash: () => 0,
        addVerifyArtifact: () => {},
        getCurrentRev: () => 0,
        recordMemoryEvent: () => {},
        getAwareness: () => undefined,
        setAwareness: () => {},
        invalidateAwareness: () => {},
        invalidateAwarenessForPaths: () => {},
        getAwarenessCache: () => new Map(),
        getStagedEntries: () => new Map(),
        chunks: new Map(),
        listBlackboardEntries: () => [],
        getBlackboardEntryWithMeta: () => null,
        getUsedTokens: () => 0,
        maxTokens: 100000,
        getStagedSnippetsForRefresh: () => [],
        markEngramsSuspect: () => {},
        recordRevisionAdvance: () => {},
        registerEditHash: () => ({ registered: true }),
        bumpWorkspaceRev: () => {},
        invalidateArtifactsForPaths: () => {},
      }),
    } as any;

    const out = await handleSearchCode({ queries: ['__per_hit_struct_test__'] }, ctx);
    expect(out.ok).toBe(true);
    expect(out.content).toMatchObject({
      file_paths: ['src/a.ts', 'src/a.ts'],
      lines: [1, 10],
    });
  });

  it('handleSearchCode uses literal line scan when FTS returns no rows but file is scoped', async () => {
    const calls: string[] = [];
    const ctx = {
      atlsBatchQuery: vi.fn(async (op: string) => {
        calls.push(op);
        if (op === 'code_search') {
          return { results: [{ query: 'return a + b', results: [] }] };
        }
        if (op === 'context') {
          return {
            results: [{
              file: '_test/a.py',
              content: 'def add():\n    return a + b\n',
            }],
          };
        }
        return {};
      }),
      store: () => ({
        addChunk: () => 'hash123',
        recordManageOps: () => {},
        recordToolCall: () => {},
        recordBatchRead: () => {},
        recordCoveragePath: () => {},
        recordFileReadSpin: () => null,
        resetFileReadSpin: () => {},
        getPriorReadRanges: () => [],
        forwardStagedHash: () => 0,
        addVerifyArtifact: () => {},
        getCurrentRev: () => 0,
        recordMemoryEvent: () => {},
        getAwareness: () => undefined,
        setAwareness: () => {},
        invalidateAwareness: () => {},
        invalidateAwarenessForPaths: () => {},
        getAwarenessCache: () => new Map(),
        getStagedEntries: () => new Map(),
        chunks: new Map(),
        listBlackboardEntries: () => [],
        getBlackboardEntryWithMeta: () => null,
        getUsedTokens: () => 0,
        maxTokens: 100000,
        getStagedSnippetsForRefresh: () => [],
        markEngramsSuspect: () => {},
        recordRevisionAdvance: () => {},
        registerEditHash: () => ({ registered: true }),
        bumpWorkspaceRev: () => {},
        invalidateArtifactsForPaths: () => {},
      }),
    } as any;

    const out = await handleSearchCode(
      { queries: ['return a + b'], file_paths: ['_test/a.py'] },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.content).toMatchObject({
      file_paths: ['_test/a.py'],
      lines: [2],
    });
    expect(calls).toEqual(['code_search', 'context']);
  });

  const minimalStore = () => ({
    addChunk: () => 'hash123',
    recordManageOps: () => {},
    recordToolCall: () => {},
    recordBatchRead: () => {},
    recordCoveragePath: () => {},
    recordFileReadSpin: () => null,
    resetFileReadSpin: () => {},
    getPriorReadRanges: () => [],
    forwardStagedHash: () => 0,
    addVerifyArtifact: () => {},
    getCurrentRev: () => 0,
    recordMemoryEvent: () => {},
    getAwareness: () => undefined,
    setAwareness: () => {},
    invalidateAwareness: () => {},
    invalidateAwarenessForPaths: () => {},
    getAwarenessCache: () => new Map(),
    getStagedEntries: () => new Map(),
    chunks: new Map(),
    listBlackboardEntries: () => [],
    getBlackboardEntryWithMeta: () => null,
    getUsedTokens: () => 0,
    maxTokens: 100000,
    getStagedSnippetsForRefresh: () => [],
    markEngramsSuspect: () => {},
    recordRevisionAdvance: () => {},
    registerEditHash: () => ({ registered: true }),
    bumpWorkspaceRev: () => {},
    invalidateArtifactsForPaths: () => {},
  });

  it('handleSearchCode uses multi-line literal match when FTS empty and scoped', async () => {
    const ctx = {
      atlsBatchQuery: vi.fn(async (op: string) => {
        if (op === 'code_search') {
          return { results: [{ query: 'needle', results: [] }] };
        }
        if (op === 'context') {
          return {
            results: [{
              file: '_test/ml.py',
              content: 'def block():\n    a = 1\n    b = 2\n',
            }],
          };
        }
        return {};
      }),
      store: () => minimalStore(),
    } as any;

    const out = await handleSearchCode(
      { queries: ['    a = 1\n    b = 2'], file_paths: ['_test/ml.py'] },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.content).toMatchObject({
      file_paths: ['_test/ml.py'],
      lines: [2],
      end_lines: [3],
    });
  });

  it('handleSearchCode prepends manifest note when hits overlap entry manifest', async () => {
    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      projectProfile: {
        entryManifest: [{ path: 'src/ManifestHit.ts' }],
      },
    } as any);

    const ctx = {
      atlsBatchQuery: vi.fn(async () => ({
        results: [{
          query: 'q',
          results: [{ file: 'src/ManifestHit.ts', line: 1 }],
        }],
      })),
      store: () => minimalStore(),
    } as any;

    const out = await handleSearchCode({ queries: ['x'] }, ctx);
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/MANIFEST:.*ManifestHit/);
  });

  it('handleSearchSymbol errors when symbol_names missing', async () => {
    const ctx = { atlsBatchQuery: vi.fn(), store: () => minimalStore() } as any;
    const out = await handleSearchSymbol({}, ctx);
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/missing symbol_names/);
    expect(ctx.atlsBatchQuery).not.toHaveBeenCalled();
  });

  it('handleSearchSymbol calls find_symbol and maps structured paths/lines', async () => {
    const batch = vi.fn(async () => ({
      results: [{ query: 'MyFn', results: [{ file: 'm.ts', line: 5, end_line: 7 }] }],
    }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleSearchSymbol({ symbol_names: ['MyFn'] }, ctx);
    expect(batch).toHaveBeenCalledWith('find_symbol', { symbol_names: ['MyFn'], query: 'MyFn' });
    expect(out.ok).toBe(true);
    expect(out.content).toMatchObject({
      file_paths: ['m.ts'],
      lines: [5],
      end_lines: [7],
    });
  });

  it('handleSearchMemory rejects too-short query', async () => {
    const searchMemory = vi.fn();
    const ctx = { store: () => ({ ...minimalStore(), searchMemory }) } as any;
    const out = await handleSearchMemory({ query: 'a' }, ctx);
    expect(out.ok).toBe(false);
    expect(searchMemory).not.toHaveBeenCalled();
  });

  it('handleSearchMemory returns zero-hit summary when searchMemory is empty', async () => {
    const ctx = {
      store: () => ({ ...minimalStore(), searchMemory: () => [] }),
    } as any;
    const out = await handleSearchMemory({ query: 'ab' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/0 hits/);
    expect(out.refs).toEqual([]);
  });

  it('handleSearchMemory summarizes hits with region breakdown and recall hint', async () => {
    const searchMemory = () => [
      {
        region: 'active' as const,
        ref: 'h:111',
        source: 's1',
        type: 'note',
        tokens: 5,
        hits: [{ lineNumber: 1, line: 'alpha' }],
      },
      {
        region: 'archived' as const,
        ref: 'h:222',
        hits: [{ lineNumber: 2, line: 'beta' }],
      },
      {
        region: 'dormant' as const,
        ref: 'h:333',
        hits: [{ lineNumber: 3, line: 'gamma' }],
      },
    ];
    const ctx = {
      store: () => ({ ...minimalStore(), searchMemory }),
    } as any;
    const out = await handleSearchMemory({ query: 'ab' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/3 hits/);
    expect(out.summary).toMatch(/active:1 archived:1 dormant:1/);
    expect(out.summary).toMatch(/rec h:XXXX/);
    expect(out.refs?.length).toBe(1);
  });

  it('handleSearchUsage calls symbol_usage and maps structured content', async () => {
    const batch = vi.fn(async () => ({
      results: [{ query: 'X', results: [{ file: 'u.ts', line: 3 }] }],
    }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleSearchUsage({ symbol_names: ['X'] }, ctx);
    expect(batch).toHaveBeenCalledWith('symbol_usage', { symbol_names: ['X'] });
    expect(out.ok).toBe(true);
    expect(out.content).toMatchObject({ file_paths: ['u.ts'], lines: [3] });
  });

  it('handleSearchIssues proxies find_issues', async () => {
    const batch = vi.fn(async () => ({ issues: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleSearchIssues({ severity: 'warn' }, ctx);
    expect(batch).toHaveBeenCalledWith('find_issues', { severity: 'warn' });
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/find_issues/);
  });

  it('handleSearchPatterns proxies detect_patterns', async () => {
    const batch = vi.fn(async () => ({ patterns: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleSearchPatterns({ ids: ['p1'] }, ctx);
    expect(batch).toHaveBeenCalledWith('detect_patterns', { ids: ['p1'] });
    expect(out.ok).toBe(true);
  });

  it('handleSearchSimilar maps type code to find_similar_code', async () => {
    const batch = vi.fn(async () => ({ hits: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleSearchSimilar({ type: 'code', query: 'auth' }, ctx);
    expect(batch).toHaveBeenCalledWith(
      'find_similar_code',
      expect.objectContaining({ type: 'code', query: 'auth' }),
    );
    expect(out.ok).toBe(true);
  });

  it('handleSearchSimilar coerces query to function_names for type function', async () => {
    const batch = vi.fn(async () => ({ hits: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleSearchSimilar({ type: 'function', query: 'doThing' }, ctx);
    expect(batch).toHaveBeenCalledWith(
      'find_similar_functions',
      expect.objectContaining({ function_names: ['doThing'] }),
    );
    expect(out.ok).toBe(true);
  });

  it('handleSearchSimilar leaves existing function_names when type function', async () => {
    const batch = vi.fn(async () => ({ hits: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    await handleSearchSimilar({ type: 'function', function_names: ['keep'] }, ctx);
    expect(batch).toHaveBeenCalledWith(
      'find_similar_functions',
      expect.objectContaining({ function_names: ['keep'] }),
    );
  });

  it('handleSearchSimilar coerces query array to concepts for type concept', async () => {
    const batch = vi.fn(async () => ({ hits: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    await handleSearchSimilar({ type: 'concept', query: ['auth', 'login'] }, ctx);
    expect(batch).toHaveBeenCalledWith(
      'find_conceptual_matches',
      expect.objectContaining({ concepts: ['auth', 'login'] }),
    );
  });

  it('handleSearchSimilar maps type pattern to find_pattern_implementations', async () => {
    const batch = vi.fn(async () => ({ hits: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    await handleSearchSimilar({ type: 'pattern', ids: ['singleton'] }, ctx);
    expect(batch).toHaveBeenCalledWith(
      'find_pattern_implementations',
      expect.objectContaining({ type: 'pattern', ids: ['singleton'] }),
    );
  });

  it('handleSearchSimilar falls back to find_similar_code for unknown type', async () => {
    const batch = vi.fn(async () => ({ hits: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    await handleSearchSimilar({ type: 'not_a_real_kind', query: 'x' }, ctx);
    expect(batch).toHaveBeenCalledWith('find_similar_code', expect.any(Object));
  });

  it('handleAnalyzeDeps errors when file_paths missing', async () => {
    const ctx = { atlsBatchQuery: vi.fn(), store: () => minimalStore() } as any;
    const out = await handleAnalyzeDeps({ mode: 'graph' }, ctx);
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/file_paths/);
    expect(ctx.atlsBatchQuery).not.toHaveBeenCalled();
  });

  it('handleAnalyzeDeps uses dependencies for graph mode', async () => {
    const batch = vi.fn(async () => ({ results: [{ f: 1 }] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleAnalyzeDeps({ file_paths: ['a.ts'], mode: 'graph' }, ctx);
    expect(batch).toHaveBeenCalledWith('dependencies', { file_paths: ['a.ts'], mode: 'graph' });
    expect(out.ok).toBe(true);
    expect(out.kind).toBe('analysis');
  });

  it('handleAnalyzeDeps uses change_impact for impact mode', async () => {
    const batch = vi.fn(async () => ({ results: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleAnalyzeDeps({ file_paths: ['b.ts'], mode: 'impact' }, ctx);
    expect(batch).toHaveBeenCalledWith('change_impact', { file_paths: ['b.ts'], mode: 'impact' });
    expect(out.ok).toBe(true);
  });

  it('handleAnalyzeBlastRadius errors when symbol_names missing', async () => {
    const ctx = { atlsBatchQuery: vi.fn(), store: () => minimalStore() } as any;
    const out = await handleAnalyzeBlastRadius({ file_paths: ['z.ts'] }, ctx);
    expect(out.ok).toBe(false);
    expect(ctx.atlsBatchQuery).not.toHaveBeenCalled();
  });

  it('handleAnalyzeBlastRadius passes file_paths[0] as from when missing', async () => {
    const batch = vi.fn(async () => ({ results: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleAnalyzeBlastRadius({ symbol_names: ['Foo'], file_paths: ['anchor.ts'] }, ctx);
    expect(batch).toHaveBeenCalledWith(
      'impact_analysis',
      expect.objectContaining({ symbol_names: ['Foo'], from: 'anchor.ts' }),
    );
    expect(out.ok).toBe(true);
  });

  it('handleAnalyzeCalls proxies call_hierarchy', async () => {
    const batch = vi.fn(async () => ({ roots: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleAnalyzeCalls({ symbol: 'main', file_path: 'app.ts' }, ctx);
    expect(batch).toHaveBeenCalledWith('call_hierarchy', { symbol: 'main', file_path: 'app.ts' });
    expect(out.ok).toBe(true);
    expect(out.kind).toBe('analysis');
  });

  it('handleAnalyzeStructure proxies symbol_dep_graph', async () => {
    const batch = vi.fn(async () => ({ nodes: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleAnalyzeStructure({ file_paths: ['x.ts'] }, ctx);
    expect(batch).toHaveBeenCalledWith('symbol_dep_graph', { file_paths: ['x.ts'] });
    expect(out.ok).toBe(true);
  });

  it('handleAnalyzeImpact proxies change_impact', async () => {
    const batch = vi.fn(async () => ({ ripples: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleAnalyzeImpact({ file_paths: ['y.ts'] }, ctx);
    expect(batch).toHaveBeenCalledWith('change_impact', { file_paths: ['y.ts'] });
    expect(out.ok).toBe(true);
  });

  it('handleAnalyzeExtractPlan proxies extract_plan', async () => {
    const batch = vi.fn(async () => ({ plan: [] }));
    const ctx = { atlsBatchQuery: batch, store: () => minimalStore() } as any;
    const out = await handleAnalyzeExtractPlan({ scope: 'mod' }, ctx);
    expect(batch).toHaveBeenCalledWith('extract_plan', { scope: 'mod' });
    expect(out.ok).toBe(true);
  });
});
