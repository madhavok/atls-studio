/**
 * Tests for engram finding persistence features:
 * - Richer dormant digests (annotations/summary in dormant lines)
 * - readCount tracking and auto-stage trigger logic
 * - getPromptTokens budgeting for annotated dormant engrams
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/hashProtocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/hashProtocol')>();
  return {
    ...actual,
    resetProtocol: vi.fn(),
    evict: vi.fn(),
    setPinned: vi.fn(),
    archive: vi.fn(),
    materialize: vi.fn(),
    dematerialize: vi.fn(),
    /** Stub ref so findReusableRead can treat chunks as in-context materialized (matches formatter+HPP contract). */
    getRef: vi.fn(() => ({
      hash: 'mockhash000000000000000000000000',
      shortHash: 'mockha',
      type: 'file',
      source: 'src/bar.ts',
      totalLines: 1,
      tokens: 1,
      editDigest: '',
      visibility: 'materialized' as const,
      seenAtTurn: 0,
    })),
    shouldMaterialize: vi.fn(() => true),
  };
});

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

function makeChunk(overrides: Partial<ContextChunk> & { hash: string }): ContextChunk {
  return {
    shortHash: overrides.hash.slice(0, 8),
    type: 'file',
    content: 'placeholder content for testing',
    tokens: 100,
    createdAt: new Date(),
    lastAccessed: Date.now(),
    source: 'src/example.ts',
    sourceRevision: 'rev_001',
    viewKind: 'latest',
    ...overrides,
  };
}

describe('engram finding persistence', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    vi.clearAllMocks();
  });

  describe('readCount tracking', () => {
    it('initializes readCount as undefined on new chunks', () => {
      const store = useContextStore.getState();
      store.addChunk('file content', 'file', 'src/foo.ts');
      const chunks = Array.from(useContextStore.getState().chunks.values());
      const chunk = chunks.find(c => c.source === 'src/foo.ts');
      expect(chunk).toBeDefined();
      expect(chunk!.readCount).toBeUndefined();
    });

    it('increments readCount on findReusableRead cache hit', () => {
      const store = useContextStore.getState();
      const hash = store.addChunk('file content here', 'file', 'src/bar.ts', undefined, undefined, undefined, {
        readSpan: { filePath: 'src/bar.ts', sourceRevision: 'rev_a' },
      });
      const shortHash = hash;

      const hit = store.findReusableRead({ filePath: 'src/bar.ts', sourceRevision: 'rev_a' });
      expect(hit).toBeTruthy();

      const chunks = Array.from(useContextStore.getState().chunks.values());
      const chunk = chunks.find(c => c.source === 'src/bar.ts');
      expect(chunk!.readCount).toBe(1);

      store.findReusableRead({ filePath: 'src/bar.ts', sourceRevision: 'rev_a' });
      const chunk2 = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/bar.ts');
      expect(chunk2!.readCount).toBe(2);
    });

    it('transfers readCount during hash forwarding', () => {
      const store = useContextStore.getState();
      store.addChunk('old content', 'file', 'src/baz.ts');

      // Simulate prior reads by setting readCount via direct store manipulation
      const state = useContextStore.getState();
      const chunks = new Map(state.chunks);
      for (const [key, c] of chunks) {
        if (c.source === 'src/baz.ts') {
          chunks.set(key, { ...c, readCount: 3 });
        }
      }
      useContextStore.setState({ chunks });

      // Re-read with new content triggers hash forwarding
      store.addChunk('new content', 'file', 'src/baz.ts');

      const newChunks = Array.from(useContextStore.getState().chunks.values());
      const active = newChunks.find(c => c.source === 'src/baz.ts' && !c.compacted && c.content === 'new content');
      expect(active).toBeDefined();
      expect(active!.readCount).toBe(4);
    });
  });

  describe('getPromptTokens budgeting', () => {
    it('uses base tokens for unannotated dormant engrams', () => {
      useContextStore.setState({
        chunks: new Map([
          ['h1', makeChunk({ hash: 'h1000000aa', compacted: true })],
        ]),
        maxTokens: 100000,
      });
      const tokens = useContextStore.getState().getPromptTokens();
      expect(tokens).toBe(15);
    });

    it('adds finding tokens for annotated dormant engrams', () => {
      useContextStore.setState({
        chunks: new Map([
          ['h2', makeChunk({
            hash: 'h2000000bb',
            compacted: true,
            annotations: [{ id: 'ann_1', content: 'stale tokens at L255', createdAt: Date.now(), tokens: 10 }],
          })],
        ]),
        maxTokens: 100000,
      });
      const tokens = useContextStore.getState().getPromptTokens();
      expect(tokens).toBe(35); // 15 base + 20 finding
    });

    it('adds finding tokens for dormant engrams with summary', () => {
      useContextStore.setState({
        chunks: new Map([
          ['h3', makeChunk({
            hash: 'h3000000cc',
            compacted: true,
            summary: 'Token counting utility',
          })],
        ]),
        maxTokens: 100000,
      });
      const tokens = useContextStore.getState().getPromptTokens();
      expect(tokens).toBe(35);
    });
  });

  describe('batchMetrics read/bbWrite tracking', () => {
    it('records batch reads and resets', () => {
      const store = useContextStore.getState();
      expect(store.batchMetrics.hadReads).toBe(false);
      store.recordBatchRead();
      expect(useContextStore.getState().batchMetrics.hadReads).toBe(true);
      store.resetBatchMetrics();
      // resetBatchMetrics requires toolCalls > 0 to actually reset
      store.recordToolCall();
      store.recordBatchRead();
      expect(useContextStore.getState().batchMetrics.hadReads).toBe(true);
      useContextStore.getState().resetBatchMetrics();
      expect(useContextStore.getState().batchMetrics.hadReads).toBe(false);
    });

    it('records batch BB writes', () => {
      const store = useContextStore.getState();
      expect(store.batchMetrics.hadBbWrite).toBe(false);
      store.recordBatchBbWrite();
      expect(useContextStore.getState().batchMetrics.hadBbWrite).toBe(true);
    });
  });
});
