import { describe, it, expect, beforeEach } from 'vitest';
import { useContextStore } from '../stores/contextStore';
import { rehydrateChunkDates, serializeMemorySnapshot } from './useChatPersistence';

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

    const snapshot = serializeMemorySnapshot(useContextStore.getState(), {
      version: '1',
      googleCacheName: null,
      vertexCacheName: null,
      googleCachedMessageCount: 0,
      vertexCachedMessageCount: 0,
    });

    expect(snapshot.version).toBe(4);
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
});
