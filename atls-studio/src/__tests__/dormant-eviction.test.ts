/**
 * Tests for stale dormant engram eviction in reconcileSourceRevision.
 *
 * Decision tree under test:
 *   snapshot                          -> preserved
 *   derived + stale                   -> evicted
 *   compacted + stale + unpinned      -> evicted (archived if >20tk, dropped if <=20tk)
 *   compacted + stale + pinned        -> updated (pin protects)
 *   active latest + stale             -> updated to new revision
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/hashProtocol', () => ({
  resetProtocol: vi.fn(),
  evict: vi.fn(),
  setPinned: vi.fn(),
  archive: vi.fn(),
  materialize: vi.fn(),
  dematerialize: vi.fn(),
  getRef: vi.fn(() => null),
  shouldMaterialize: vi.fn(() => false),
}));

vi.mock('../services/hashProtocolQuery', () => ({
  getActiveRefs: vi.fn(() => []),
}));

vi.mock('../services/hashProtocolState', () => ({
  setPinned: vi.fn(),
  setRoundRefreshHook: vi.fn(),
  getRoundRefreshHook: vi.fn(() => null),
}));

vi.mock('./roundHistoryStore', () => ({
  useRoundHistoryStore: { getState: () => ({ addEntry: vi.fn() }) },
}));

import { useContextStore, type ContextChunk } from '../stores/contextStore';
import { evict as hppEvict } from '../services/hashProtocol';

const SOURCE_PATH = 'src/components/Panel.tsx';
const OLD_REV = 'rev_aaa111';
const NEW_REV = 'rev_bbb222';

function makeChunk(overrides: Partial<ContextChunk> & { hash: string }): ContextChunk {
  return {
    shortHash: overrides.hash.slice(0, 8),
    type: 'file',
    content: 'placeholder',
    tokens: 100,
    createdAt: new Date(),
    lastAccessed: Date.now(),
    source: SOURCE_PATH,
    sourceRevision: OLD_REV,
    viewKind: 'latest',
    ...overrides,
  };
}

function seedChunks(chunks: ContextChunk[], archived: ContextChunk[] = []) {
  const state = useContextStore.getState();
  const chunkMap = new Map(state.chunks);
  const archiveMap = new Map(state.archivedChunks);
  for (const c of chunks) chunkMap.set(c.hash, c);
  for (const c of archived) archiveMap.set(c.hash, c);
  useContextStore.setState({ chunks: chunkMap, archivedChunks: archiveMap });
}

describe('reconcileSourceRevision: dormant eviction', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    vi.clearAllMocks();
  });

  it('evicts compacted+stale+unpinned dormant chunks from working memory', () => {
    const dormant = makeChunk({
      hash: 'dormant_stale_1234567890',
      compacted: true,
      tokens: 50,
    });
    seedChunks([dormant]);

    const stats = useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(stats.invalidated).toBe(1);
    expect(stats.total).toBe(1);
    expect(useContextStore.getState().chunks.has(dormant.hash)).toBe(false);
    expect(hppEvict).toHaveBeenCalledWith(dormant.hash);
  });

  it('archives evicted dormant result engrams (>1000tk)', () => {
    const resultEngram = makeChunk({
      hash: 'result_engram_1234567890',
      compacted: true,
      tokens: 1500,
    });
    seedChunks([resultEngram]);

    useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(useContextStore.getState().chunks.has(resultEngram.hash)).toBe(false);
    expect(useContextStore.getState().archivedChunks.has(resultEngram.hash)).toBe(true);
  });

  it('drops batch call stubs (<=1000tk) without archiving', () => {
    const batchStub = makeChunk({
      hash: 'batch_stub_1234567890ab',
      compacted: true,
      tokens: 7,
    });
    seedChunks([batchStub]);

    useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(useContextStore.getState().chunks.has(batchStub.hash)).toBe(false);
    expect(useContextStore.getState().archivedChunks.has(batchStub.hash)).toBe(false);
  });

  it('preserves pinned dormant chunks even when stale', () => {
    const pinned = makeChunk({
      hash: 'pinned_dormant_1234567890',
      compacted: true,
      pinned: true,
      tokens: 50,
    });
    seedChunks([pinned]);

    const stats = useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(stats.updated).toBe(1);
    expect(stats.invalidated).toBe(0);
    const updated = useContextStore.getState().chunks.get(pinned.hash);
    expect(updated).toBeDefined();
    expect(updated!.sourceRevision).toBe(NEW_REV);
  });

  it('updates active (non-compacted) latest chunks to new revision', () => {
    const active = makeChunk({
      hash: 'active_latest_1234567890',
      compacted: false,
      tokens: 2000,
    });
    seedChunks([active]);

    const stats = useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(stats.updated).toBe(1);
    expect(stats.invalidated).toBe(0);
    const updated = useContextStore.getState().chunks.get(active.hash);
    expect(updated).toBeDefined();
    expect(updated!.sourceRevision).toBe(NEW_REV);
    expect(updated!.observedRevision).toBe(NEW_REV);
  });

  it('preserves snapshot chunks regardless of revision', () => {
    const snapshot = makeChunk({
      hash: 'snapshot_chunk_1234567890',
      viewKind: 'snapshot',
      compacted: true,
      tokens: 500,
    });
    seedChunks([snapshot]);

    const stats = useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(stats.preserved).toBe(1);
    expect(stats.invalidated).toBe(0);
    expect(useContextStore.getState().chunks.has(snapshot.hash)).toBe(true);
  });

  it('evicts derived+stale chunks (existing behavior)', () => {
    const derived = makeChunk({
      hash: 'derived_stale_1234567890',
      viewKind: 'derived',
      tokens: 300,
    });
    seedChunks([derived]);

    const stats = useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(stats.invalidated).toBe(1);
    expect(useContextStore.getState().chunks.has(derived.hash)).toBe(false);
  });

  it('evicts stale dormant chunks from archive, drops stubs', () => {
    const archivedResult = makeChunk({
      hash: 'archived_result_1234567890',
      compacted: true,
      tokens: 200,
    });
    const archivedStub = makeChunk({
      hash: 'archived_stub_1234567890a',
      compacted: true,
      tokens: 7,
    });
    seedChunks([], [archivedResult, archivedStub]);

    const stats = useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(stats.invalidated).toBe(2);
    // Stub dropped entirely; result stays in archive (already there, not re-added)
    expect(useContextStore.getState().archivedChunks.has(archivedStub.hash)).toBe(false);
  });

  it('handles mixed chunk states in a single reconcile call', () => {
    const active = makeChunk({ hash: 'mix_active_1234567890ab', compacted: false, tokens: 1000 });
    const dormantResult = makeChunk({ hash: 'mix_dormant_1234567890a', compacted: true, tokens: 1500 });
    const dormantStub = makeChunk({ hash: 'mix_stub_1234567890abc', compacted: true, tokens: 7 });
    const snapshot = makeChunk({ hash: 'mix_snapshot_1234567890', viewKind: 'snapshot', tokens: 500 });
    const derived = makeChunk({ hash: 'mix_derived_1234567890a', viewKind: 'derived', tokens: 300 });
    seedChunks([active, dormantResult, dormantStub, snapshot, derived]);

    const stats = useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    expect(stats.total).toBe(5);
    expect(stats.updated).toBe(1);       // active
    expect(stats.invalidated).toBe(3);   // dormantResult + dormantStub + derived
    expect(stats.preserved).toBe(1);     // snapshot

    const chunks = useContextStore.getState().chunks;
    expect(chunks.has(active.hash)).toBe(true);
    expect(chunks.has(snapshot.hash)).toBe(true);
    expect(chunks.has(dormantResult.hash)).toBe(false);
    expect(chunks.has(dormantStub.hash)).toBe(false);
    expect(chunks.has(derived.hash)).toBe(false);

    // Result engram archived, stub dropped
    const archive = useContextStore.getState().archivedChunks;
    expect(archive.has(dormantResult.hash)).toBe(true);
    expect(archive.has(dormantStub.hash)).toBe(false);
  });

  it('logs dormant_evicted count in memory events', () => {
    const stub1 = makeChunk({ hash: 'evt_stub1_1234567890ab', compacted: true, tokens: 7 });
    const stub2 = makeChunk({ hash: 'evt_stub2_1234567890ab', compacted: true, tokens: 7 });
    const result = makeChunk({ hash: 'evt_result_1234567890a', compacted: true, tokens: 100 });
    seedChunks([stub1, stub2, result]);

    useContextStore.getState().reconcileSourceRevision(SOURCE_PATH, NEW_REV);

    const events = useContextStore.getState().memoryEvents;
    const reconcileEvent = events.find(e => e.action === 'reconcile' && e.reason === 'source_reread');
    expect(reconcileEvent).toBeDefined();
    expect(reconcileEvent!.refs).toContain('dormant_evicted:3');
    expect(reconcileEvent!.refs).toContain('invalidated:3');
  });
});

describe('evictStaleDormantChunks: LRU order', () => {
  const MAX_DORMANT_CHUNKS = 1000;

  beforeEach(() => {
    useContextStore.getState().resetSession();
    vi.clearAllMocks();
  });

  it('evicts oldest dormant chunks first (LRU order when lastAccessed set)', () => {
    const base = Date.now() - 10000;
    const oldest = [
      makeChunk({ hash: 'evict_old1_1234567890ab', compacted: true, tokens: 7, lastAccessed: base }),
      makeChunk({ hash: 'evict_old2_1234567890ab', compacted: true, tokens: 7, lastAccessed: base + 100 }),
      makeChunk({ hash: 'evict_old3_1234567890ab', compacted: true, tokens: 7, lastAccessed: base + 200 }),
    ];
    const recent = Array.from({ length: MAX_DORMANT_CHUNKS }, (_, i) =>
      makeChunk({
        hash: `evict_recent_${i}_1234567890`,
        compacted: true,
        tokens: 7,
        lastAccessed: base + 5000 + i,
      }),
    );
    seedChunks([...oldest, ...recent]);

    const result = useContextStore.getState().evictStaleDormantChunks();

    expect(result.evicted).toBe(3);
    const chunks = useContextStore.getState().chunks;
    expect(chunks.has(oldest[0].hash)).toBe(false);
    expect(chunks.has(oldest[1].hash)).toBe(false);
    expect(chunks.has(oldest[2].hash)).toBe(false);
    for (const c of recent) expect(chunks.has(c.hash)).toBe(true);
  });
});
