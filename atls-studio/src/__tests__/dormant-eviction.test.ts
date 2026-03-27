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
  setRoundRefreshHook: vi.fn(),
  getRoundRefreshHook: vi.fn(() => null),
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
import { evict as hppEvict, getRef, type ChunkRef } from '../services/hashProtocol';
import { buildDormantBlock } from '../services/aiService';
import { hashContentSync } from '../utils/contextHash';

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
  /** Must match MAX_DORMANT_CHUNKS in contextStore.ts */
  const MAX_DORMANT_CHUNKS = 100;

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

  it('evicts excess compacted stubs when count exceeds MAX_DORMANT_CHUNKS', () => {
    const base = Date.now();
    const many = Array.from({ length: 101 }, (_, i) =>
      makeChunk({
        hash: `srch_${i.toString().padStart(3, '0')}_1234567890ab`,
        type: 'search',
        compacted: true,
        tokens: 30,
        lastAccessed: base + i,
      }),
    );
    seedChunks(many);

    const result = useContextStore.getState().evictStaleDormantChunks();

    expect(result.evicted).toBe(1);
    expect(useContextStore.getState().chunks.size).toBe(100);
  });
});

describe('pruneObsoleteTaskArtifacts: compacted stub auto-drop', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    vi.clearAllMocks();
  });

  it('drops compacted search/symbol/deps/analysis stubs at or below 50tk', () => {
    const searchStub = makeChunk({
      hash: 'drop_srch_1234567890ab',
      type: 'search',
      compacted: true,
      tokens: 40,
    });
    const analysisStub = makeChunk({
      hash: 'drop_an_1234567890abc',
      type: 'analysis',
      compacted: true,
      tokens: 50,
    });
    seedChunks([searchStub, analysisStub]);

    const r = useContextStore.getState().pruneObsoleteTaskArtifacts();

    expect(r.dropped).toBe(2);
    expect(useContextStore.getState().chunks.has(searchStub.hash)).toBe(false);
    expect(useContextStore.getState().chunks.has(analysisStub.hash)).toBe(false);
  });

  it('does not auto-drop compacted search stubs above 50tk', () => {
    const big = makeChunk({
      hash: 'keep_srch_1234567890a',
      type: 'search',
      compacted: true,
      tokens: 51,
    });
    seedChunks([big]);

    const r = useContextStore.getState().pruneObsoleteTaskArtifacts();

    expect(r.dropped).toBe(0);
    expect(useContextStore.getState().chunks.has(big.hash)).toBe(true);
  });
});

describe('buildDormantBlock', () => {
  const refStub = (hash: string, shortHash: string): ChunkRef => ({
    hash,
    shortHash,
    type: 'search',
    source: 'q',
    totalLines: 1,
    tokens: 10,
    editDigest: '',
    visibility: 'referenced',
    seenAtTurn: 0,
  });

  beforeEach(() => {
    useContextStore.getState().resetSession();
    vi.clearAllMocks();
    vi.mocked(getRef).mockImplementation((h: string) => refStub(h, h.slice(0, 6)));
  });

  it('caps dormant listing at 40 lines with overflow summary', () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      makeChunk({
        hash: `db_${i.toString().padStart(3, '0')}_1234567890ab`,
        type: 'search',
        compacted: true,
        tokens: 12,
        source: `hit${i}.ts`,
      }),
    );
    seedChunks(many);

    const block = buildDormantBlock();

    const lines = block.split('\n');
    expect(lines[0]).toBe('## DORMANT ENGRAMS');
    expect(lines.length).toBe(42);
    expect(lines[41]).toMatch(/^\.\.\. and 5 more dormant engrams/);
  });
});

describe('addChunk: search TTL', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    vi.clearAllMocks();
  });

  it('defaults ttl to 5 for search chunks', () => {
    const content = `needle_ttl_${Date.now()}_${Math.random()}`;
    const fullHash = hashContentSync(content);
    useContextStore.getState().addChunk(content, 'search', 'workspace');
    const c = useContextStore.getState().chunks.get(fullHash);
    expect(c?.ttl).toBe(5);
  });
});
