import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useContextStore, setBulkRevisionResolver } from '../stores/contextStore';
import { rehydrateChunkDates, serializeMemorySnapshot, applyHashFirstFreshness } from './useChatPersistence';
import { recordFreshnessJournal, getFreshnessJournal, clearFreshnessJournal, serializeJournal, restoreJournal } from '../services/freshnessJournal';

const DUMMY_GEMINI_CACHE = {
  version: '1',
  googleCacheName: null,
  vertexCacheName: null,
  googleCachedMessageCount: 0,
  vertexCachedMessageCount: 0,
} as const;

describe('memory snapshot helpers', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('serializes the full memory model needed for restore', () => {
    const store = useContextStore.getState();
    const chunkHash = store.addChunk('export const value = 1;', 'smart', 'src/persist.ts', undefined, undefined, 'rev-1', {
      sourceRevision: 'rev-1',
      viewKind: 'latest',
    });
    store.stageSnippet('stage:test', 'sig value(): number', 'src/persist.ts', 'sig', 'rev-1', 'sig', 'derived');
    store.recordRebindOutcomes([{
      ref: `h:${chunkHash}`,
      source: 'src/persist.ts',
      classification: 'rebaseable',
      strategy: 'symbol_identity',
      confidence: 'medium',
      factors: ['symbol_identity'],
      linesBefore: '2-4',
      linesAfter: '4-6',
      sourceRevision: 'rev-1',
      observedRevision: 'rev-2',
      at: Date.now(),
    }]);
    store.setBlackboardEntry('decision', 'keep provenance');
    store.setRule('freshness', 're-read suspect refs before editing');
    store.recordMemoryEvent({
      action: 'reconcile',
      reason: 'unit_test',
      source: 'src/persist.ts',
      newRevision: 'rev-1',
      strategy: 'symbol_identity',
      confidence: 'medium',
      factors: ['symbol_identity'],
    });

    const snapshot = serializeMemorySnapshot(useContextStore.getState(), DUMMY_GEMINI_CACHE);

    expect(snapshot.version).toBe(6);
    expect(snapshot.rollingSummary).toBeDefined();
    expect(snapshot.promptMetrics).toBeDefined();
    expect(snapshot.cacheMetrics).toBeDefined();
    expect(snapshot.costChat).toBeDefined();
    expect(snapshot.roundHistorySnapshots).toEqual([]);
    expect(snapshot.chunks).toHaveLength(1);
    expect(snapshot.stagedSnippets).toHaveLength(1);
    expect(snapshot.chunks[0]?.lastRebind).toMatchObject({
      strategy: 'symbol_identity',
      confidence: 'medium',
    });
    expect(snapshot.blackboardEntries.some(([key]) => key === 'decision')).toBe(true);
    expect(snapshot.cognitiveRules.some(([key]) => key === 'freshness')).toBe(true);
    const latestEvent = snapshot.memoryEvents[snapshot.memoryEvents.length - 1];
    expect(latestEvent?.reason).toBe('unit_test');
    expect(latestEvent).toMatchObject({
      strategy: 'symbol_identity',
      confidence: 'medium',
      factors: ['symbol_identity'],
    });
  });

  it('rehydrates chunk dates back to Date instances', () => {
    const hydrated = rehydrateChunkDates([{
      hash: 'abc123456789',
      shortHash: 'abc12345',
      type: 'smart',
      source: 'src/date.ts',
      content: 'value',
      tokens: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastAccessed: Date.now(),
    }]);

    expect(hydrated[0]?.createdAt).toBeInstanceOf(Date);
    expect(hydrated[0]?.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('ensures lastAccessed when restoring chunks without it', () => {
    const hydrated = rehydrateChunkDates([{
      hash: 'legacy123456789',
      shortHash: 'legacy123',
      type: 'smart',
      source: 'src/legacy.ts',
      content: 'legacy',
      tokens: 1,
      createdAt: new Date('2025-06-15T12:00:00.000Z'),
      // lastAccessed omitted (legacy snapshot)
    }]);

    expect(hydrated[0]?.lastAccessed).toBeDefined();
    expect(typeof hydrated[0]?.lastAccessed).toBe('number');
    expect(hydrated[0]?.lastAccessed).toBe(new Date('2025-06-15T12:00:00.000Z').getTime());
  });

  it('v6 round-trips verifyArtifacts, awarenessCache, coverage, and spin state', () => {
    const store = useContextStore.getState();

    store.addChunk('const x = 1;', 'smart', 'src/a.ts');

    useContextStore.setState({
      verifyArtifacts: new Map([
        ['va-1', {
          id: 'va-1', createdAtRev: 3, filesObserved: ['src/a.ts'],
          ok: true, warnings: 0, errors: 0, stepId: 'step-1',
          confidence: 'fresh' as const, source: 'command' as const, stale: false,
        }],
      ]),
      awarenessCache: new Map([
        ['src/b.ts|abc', {
          filePath: 'src/b.ts', snapshotHash: 'abc', level: 2,
          readRegions: [{ start: 1, end: 50 }], recordedAt: Date.now(),
        }],
      ]),
      cumulativeCoveragePaths: new Set(['src/a.ts', 'src/b.ts']),
      fileReadSpinByPath: { 'src/a.ts|*': 2 },
      fileReadSpinRanges: { 'src/a.ts': ['*', '1-10'] },
    });

    const snapshot = serializeMemorySnapshot(useContextStore.getState(), DUMMY_GEMINI_CACHE);

    expect(snapshot.version).toBe(6);
    expect(snapshot.verifyArtifacts).toHaveLength(1);
    expect(snapshot.verifyArtifacts![0]![0]).toBe('va-1');
    expect(snapshot.awarenessCache).toHaveLength(1);
    expect(snapshot.cumulativeCoveragePaths).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(snapshot.fileReadSpinByPath).toEqual({ 'src/a.ts|*': 2 });
    expect(snapshot.fileReadSpinRanges).toEqual({ 'src/a.ts': ['*', '1-10'] });

    // Simulate restore: reset then apply
    useContextStore.getState().resetSession();

    const restoredState = useContextStore.getState();
    expect(restoredState.verifyArtifacts.size).toBe(0);
    expect(restoredState.awarenessCache.size).toBe(0);
    expect(restoredState.cumulativeCoveragePaths.size).toBe(0);

    useContextStore.setState({
      verifyArtifacts: new Map(snapshot.verifyArtifacts ?? []),
      awarenessCache: new Map(snapshot.awarenessCache ?? []),
      cumulativeCoveragePaths: new Set(snapshot.cumulativeCoveragePaths ?? []),
      fileReadSpinByPath: snapshot.fileReadSpinByPath ?? {},
      fileReadSpinRanges: snapshot.fileReadSpinRanges ?? {},
    });

    const after = useContextStore.getState();
    expect(after.verifyArtifacts.get('va-1')?.ok).toBe(true);
    expect(after.awarenessCache.get('src/b.ts|abc')?.level).toBe(2);
    expect(after.cumulativeCoveragePaths.has('src/a.ts')).toBe(true);
    expect(after.cumulativeCoveragePaths.has('src/b.ts')).toBe(true);
    expect(after.fileReadSpinByPath['src/a.ts|*']).toBe(2);
    expect(after.fileReadSpinRanges['src/a.ts']).toEqual(['*', '1-10']);
  });

  it('v5 snapshots restore gracefully with empty v6 fields', () => {
    const store = useContextStore.getState();
    store.addChunk('const y = 2;', 'smart', 'src/c.ts');
    const snapshot = serializeMemorySnapshot(useContextStore.getState(), DUMMY_GEMINI_CACHE);

    // Simulate a v5 snapshot by stripping v6 fields
    const v5Snapshot = { ...snapshot, version: 5 as const };
    delete (v5Snapshot as Record<string, unknown>).verifyArtifacts;
    delete (v5Snapshot as Record<string, unknown>).awarenessCache;
    delete (v5Snapshot as Record<string, unknown>).cumulativeCoveragePaths;
    delete (v5Snapshot as Record<string, unknown>).fileReadSpinByPath;
    delete (v5Snapshot as Record<string, unknown>).fileReadSpinRanges;

    useContextStore.getState().resetSession();
    useContextStore.setState({
      verifyArtifacts: new Map(v5Snapshot.verifyArtifacts ?? []),
      awarenessCache: new Map(v5Snapshot.awarenessCache ?? []),
      cumulativeCoveragePaths: new Set(v5Snapshot.cumulativeCoveragePaths ?? []),
      fileReadSpinByPath: v5Snapshot.fileReadSpinByPath ?? {},
      fileReadSpinRanges: v5Snapshot.fileReadSpinRanges ?? {},
    });

    const after = useContextStore.getState();
    expect(after.verifyArtifacts.size).toBe(0);
    expect(after.awarenessCache.size).toBe(0);
    expect(after.cumulativeCoveragePaths.size).toBe(0);
    expect(after.fileReadSpinByPath).toEqual({});
    expect(after.fileReadSpinRanges).toEqual({});
  });

  it('resetSession zeroes batchMetrics, coverage, and plateau fields', () => {
    useContextStore.setState({
      batchMetrics: { toolCalls: 5, manageOps: 3, hadReads: true, hadBbWrite: true, hadSubstantiveBbWrite: true },
      cumulativeCoveragePaths: new Set(['src/a.ts', 'src/b.ts']),
      _roundCoveragePaths: new Set(['src/a.ts']),
      roundNewCoverage: 2,
      coveragePlateauStreak: 3,
    });

    useContextStore.getState().resetSession();

    const after = useContextStore.getState();
    expect(after.batchMetrics).toEqual({ toolCalls: 0, manageOps: 0, hadReads: false, hadBbWrite: false, hadSubstantiveBbWrite: false });
    expect(after.cumulativeCoveragePaths.size).toBe(0);
    expect(after._roundCoveragePaths.size).toBe(0);
    expect(after.roundNewCoverage).toBe(0);
    expect(after.coveragePlateauStreak).toBe(0);
  });
});

describe('applyHashFirstFreshness', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    setBulkRevisionResolver(null);
  });

  it('preserves freshness for unchanged files (no suspect, no reread pressure)', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const x = 1;', 'file', 'src/unchanged.ts', undefined, undefined, 'rev-abc', {
      sourceRevision: 'rev-abc',
      viewKind: 'latest',
    });
    store.stageSnippet('stage:unchanged', 'function foo() {}', 'src/unchanged.ts', undefined, 'rev-abc', undefined, 'latest');

    setBulkRevisionResolver(async (paths) =>
      new Map(paths.map(p => [p, 'rev-abc'])),
    );

    const result = await applyHashFirstFreshness();

    expect(result.preserved).toBeGreaterThanOrEqual(2);
    expect(result.suspect).toBe(0);
    expect(result.staleSnippets).toBe(0);
    expect(result.changedPaths).toHaveLength(0);

    const state = useContextStore.getState();
    for (const chunk of state.chunks.values()) {
      if (chunk.type === 'file') {
        expect(chunk.freshness).not.toBe('suspect');
        expect(chunk.suspectSince).toBeUndefined();
      }
    }
    for (const snippet of state.stagedSnippets.values()) {
      expect(snippet.stageState).not.toBe('stale');
      expect(snippet.suspectSince).toBeUndefined();
    }
  });

  it('marks chunks suspect when disk revision differs', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const x = 1;', 'file', 'src/changed.ts', undefined, undefined, 'rev-old', {
      sourceRevision: 'rev-old',
      viewKind: 'latest',
    });

    setBulkRevisionResolver(async (paths) =>
      new Map(paths.map(p => [p, 'rev-new'])),
    );

    const result = await applyHashFirstFreshness();

    expect(result.suspect).toBe(1);
    expect(result.preserved).toBe(0);
    expect(result.changedPaths).toHaveLength(1);

    for (const chunk of useContextStore.getState().chunks.values()) {
      if (chunk.type === 'file') {
        expect(chunk.freshness).toBe('suspect');
        expect(chunk.freshnessCause).toBe('session_restore');
      }
    }
  });

  it('marks chunks suspect when sourceRevision is missing on chunk', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const x = 1;', 'file', 'src/no-rev.ts');

    setBulkRevisionResolver(async (paths) =>
      new Map(paths.map(p => [p, 'rev-disk'])),
    );

    const result = await applyHashFirstFreshness();

    expect(result.suspect).toBe(1);
    expect(result.preserved).toBe(0);
  });

  it('falls back to blanket suspect when resolver is not available', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const x = 1;', 'file', 'src/test.ts', undefined, undefined, 'rev-abc', {
      sourceRevision: 'rev-abc',
      viewKind: 'latest',
    });

    const result = await applyHashFirstFreshness();

    expect(result.preserved).toBe(0);
    expect(result.suspect).toBe(0);

    for (const chunk of useContextStore.getState().chunks.values()) {
      if (chunk.type === 'file') {
        expect(chunk.freshness).toBe('suspect');
      }
    }
  });

  it('preserves snapshot view kind chunks as-is regardless of disk', async () => {
    useContextStore.setState(state => {
      const chunks = new Map(state.chunks);
      chunks.set('snap-hash', {
        hash: 'snap-hash',
        shortHash: 'snap-ha',
        type: 'file',
        source: 'src/frozen.ts',
        content: 'frozen content',
        tokens: 5,
        createdAt: new Date(),
        viewKind: 'snapshot',
        sourceRevision: 'rev-frozen',
      } as import('../stores/contextStore').ContextChunk);
      return { chunks };
    });

    setBulkRevisionResolver(async (paths) =>
      new Map(paths.map(p => [p, 'rev-different'])),
    );

    const result = await applyHashFirstFreshness();

    const chunk = useContextStore.getState().chunks.get('snap-hash');
    expect(chunk?.freshness).not.toBe('suspect');
    expect(chunk?.viewKind).toBe('snapshot');
  });

  it('preserves non-file-backed chunks (msg:user, etc.) as-is', async () => {
    useContextStore.setState(state => {
      const chunks = new Map(state.chunks);
      chunks.set('msg-hash', {
        hash: 'msg-hash',
        shortHash: 'msg-ha',
        type: 'msg:user',
        source: undefined,
        content: 'user message',
        tokens: 3,
        createdAt: new Date(),
      } as import('../stores/contextStore').ContextChunk);
      return { chunks };
    });

    setBulkRevisionResolver(async () => new Map());

    const result = await applyHashFirstFreshness();

    const chunk = useContextStore.getState().chunks.get('msg-hash');
    expect(chunk?.freshness).not.toBe('suspect');
  });

  it('falls back to blanket suspect when resolver throws', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const x = 1;', 'file', 'src/error.ts', undefined, undefined, 'rev-abc', {
      sourceRevision: 'rev-abc',
      viewKind: 'latest',
    });

    setBulkRevisionResolver(async () => { throw new Error('IPC fail'); });

    const result = await applyHashFirstFreshness();

    expect(result.preserved).toBe(0);

    for (const chunk of useContextStore.getState().chunks.values()) {
      if (chunk.type === 'file') {
        expect(chunk.freshness).toBe('suspect');
      }
    }
  });

  it('marks staged snippets stale only when disk revision differs', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('stage:fresh', 'fn foo() {}', 'src/ok.ts', undefined, 'rev-ok', undefined, 'latest');
    store.stageSnippet('stage:stale', 'fn bar() {}', 'src/changed.ts', undefined, 'rev-old', undefined, 'latest');

    setBulkRevisionResolver(async (paths) => {
      const map = new Map<string, string | null>();
      for (const p of paths) {
        if (p.includes('ok')) map.set(p, 'rev-ok');
        else map.set(p, 'rev-new');
      }
      return map;
    });

    const result = await applyHashFirstFreshness();

    expect(result.staleSnippets).toBe(1);
    expect(result.preserved).toBeGreaterThanOrEqual(1);

    const snippets = useContextStore.getState().stagedSnippets;
    const fresh = snippets.get('stage:fresh');
    const stale = snippets.get('stage:stale');
    expect(fresh?.stageState).not.toBe('stale');
    expect(stale?.stageState).toBe('stale');
  });
});

describe('freshness journal persistence', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    clearFreshnessJournal();
  });

  it('round-trips the freshness journal through serialize/restore', () => {
    recordFreshnessJournal({
      source: 'src/a.ts',
      previousRevision: 'rev-1',
      currentRevision: 'rev-2',
      lineDelta: 3,
      recordedAt: Date.now(),
    });
    recordFreshnessJournal({
      source: 'src/b.ts',
      currentRevision: 'rev-5',
      lineDelta: -2,
      recordedAt: Date.now(),
    });

    const snapshot = serializeMemorySnapshot(useContextStore.getState(), DUMMY_GEMINI_CACHE);
    expect(snapshot.freshnessJournal).toBeDefined();
    expect(snapshot.freshnessJournal).toHaveLength(2);

    clearFreshnessJournal();
    expect(getFreshnessJournal('src/a.ts')).toBeUndefined();

    restoreJournal(snapshot.freshnessJournal!);

    const restored = getFreshnessJournal('src/a.ts');
    expect(restored).toBeDefined();
    expect(restored?.lineDelta).toBe(3);
    expect(restored?.currentRevision).toBe('rev-2');
    expect(restored?.previousRevision).toBe('rev-1');

    const restoredB = getFreshnessJournal('src/b.ts');
    expect(restoredB).toBeDefined();
    expect(restoredB?.lineDelta).toBe(-2);
  });

  it('handles empty journal gracefully', () => {
    const snapshot = serializeMemorySnapshot(useContextStore.getState(), DUMMY_GEMINI_CACHE);
    expect(snapshot.freshnessJournal).toEqual([]);

    restoreJournal([]);
    expect(getFreshnessJournal('src/any.ts')).toBeUndefined();
  });
});

describe('full snapshot round-trip', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    clearFreshnessJournal();
  });

  it('all session state survives serialize → reset → restore', () => {
    const store = useContextStore.getState();

    const chunkHash = store.addChunk('const x = 1;', 'smart', 'src/roundtrip.ts', undefined, undefined, 'rev-rt', {
      sourceRevision: 'rev-rt',
      viewKind: 'latest',
    });
    store.setBlackboardEntry('plan', 'implement feature X');
    store.setRule('style', 'use camelCase');
    store.stageSnippet('stage:rt', 'fn main() {}', 'src/roundtrip.ts', '1-5', 'rev-rt', undefined, 'latest');
    store.setTaskPlan({ goal: 'build feature X', subtasks: [{ id: 'sub-1', title: 'step 1', status: 'active' }] } as any);

    recordFreshnessJournal({
      source: 'src/roundtrip.ts',
      currentRevision: 'rev-rt',
      lineDelta: 5,
      recordedAt: Date.now(),
    });

    useContextStore.setState({
      verifyArtifacts: new Map([['va-rt', {
        id: 'va-rt', createdAtRev: 1, filesObserved: ['src/roundtrip.ts'],
        ok: true, warnings: 0, errors: 0, stepId: 's1',
        confidence: 'fresh' as const, source: 'command' as const, stale: false,
      }]]),
      cumulativeCoveragePaths: new Set(['src/roundtrip.ts']),
      fileReadSpinByPath: { 'src/roundtrip.ts|*': 1 },
    });

    const snapshot = serializeMemorySnapshot(useContextStore.getState(), DUMMY_GEMINI_CACHE);

    // Reset everything
    store.resetSession();
    clearFreshnessJournal();

    // Verify clean state
    const clean = useContextStore.getState();
    expect(clean.chunks.size).toBe(0);
    expect(clean.cognitiveRules.size).toBe(0);
    expect(clean.stagedSnippets.size).toBe(0);
    expect(clean.verifyArtifacts.size).toBe(0);
    expect(getFreshnessJournal('src/roundtrip.ts')).toBeUndefined();

    // Restore from snapshot
    useContextStore.setState({
      chunks: new Map(rehydrateChunkDates(snapshot.chunks).map(c => [c.hash, c])),
      archivedChunks: new Map(rehydrateChunkDates(snapshot.archivedChunks).map(c => [c.hash, c])),
      droppedManifest: new Map(snapshot.droppedManifest),
      stagedSnippets: new Map(snapshot.stagedSnippets),
      blackboardEntries: new Map(snapshot.blackboardEntries.map(([k, e]) => [k, e])),
      cognitiveRules: new Map(snapshot.cognitiveRules.map(([k, r]) => [k, { ...r, createdAt: new Date(r.createdAt) }])),
      taskPlan: snapshot.taskPlan,
      freedTokens: snapshot.freedTokens,
      stageVersion: snapshot.stageVersion,
      hashStack: snapshot.hashStack,
      editHashStack: snapshot.editHashStack,
      readHashStack: snapshot.readHashStack,
      stageHashStack: snapshot.stageHashStack,
      memoryEvents: snapshot.memoryEvents ?? [],
      verifyArtifacts: new Map(snapshot.verifyArtifacts ?? []),
      awarenessCache: new Map(snapshot.awarenessCache ?? []),
      cumulativeCoveragePaths: new Set(snapshot.cumulativeCoveragePaths ?? []),
      fileReadSpinByPath: snapshot.fileReadSpinByPath ?? {},
      fileReadSpinRanges: snapshot.fileReadSpinRanges ?? {},
    });
    if (snapshot.freshnessJournal?.length) {
      restoreJournal(snapshot.freshnessJournal);
    }

    // Verify all state round-tripped
    const restored = useContextStore.getState();
    expect(restored.chunks.size).toBe(1);
    expect(restored.chunks.get(chunkHash)?.source).toBe('src/roundtrip.ts');
    expect(restored.stagedSnippets.size).toBe(1);
    expect(restored.stagedSnippets.get('stage:rt')?.content).toBe('fn main() {}');

    const bbPlan = restored.blackboardEntries.get('plan');
    expect(bbPlan?.content).toBe('implement feature X');

    expect(restored.cognitiveRules.size).toBe(1);
    expect(restored.cognitiveRules.get('style')?.content).toBe('use camelCase');

    expect(restored.taskPlan?.goal).toBe('build feature X');
    expect(restored.taskPlan?.subtasks).toHaveLength(1);

    expect(restored.verifyArtifacts.get('va-rt')?.ok).toBe(true);
    expect(restored.cumulativeCoveragePaths.has('src/roundtrip.ts')).toBe(true);
    expect(restored.fileReadSpinByPath['src/roundtrip.ts|*']).toBe(1);

    const journal = getFreshnessJournal('src/roundtrip.ts');
    expect(journal).toBeDefined();
    expect(journal?.lineDelta).toBe(5);
    expect(journal?.currentRevision).toBe('rev-rt');
  });
});
