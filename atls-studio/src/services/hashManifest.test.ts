import { afterEach, describe, expect, it } from 'vitest';
import {
  recordForwarding,
  recordEviction,
  clearForward,
  clearEviction,
  pruneStaleEntries,
  resolveForward,
  hasForward,
  getForwardMap,
  getEvictionMap,
  resetManifestState,
  formatHashManifest,
  formatManifestType,
  getManifestMetrics,
  type ForwardEntry,
} from './hashManifest';
import type { ChunkRef } from './hashProtocol';

function makeRef(overrides: Partial<ChunkRef> = {}): ChunkRef {
  return {
    hash: 'abcdef1234567890',
    shortHash: 'abcdef',
    type: 'file',
    source: 'src/foo.ts',
    totalLines: 50,
    tokens: 1200,
    editDigest: '',
    visibility: 'referenced',
    seenAtTurn: 1,
    ...overrides,
  };
}

describe('hashManifest', () => {
  afterEach(() => {
    resetManifestState();
  });

  describe('recording', () => {
    it('records and resolves a forwarding entry', () => {
      recordForwarding('abc123', 'def456', 'src/foo.ts', 'hash_forward', 5);
      expect(hasForward('abc123')).toBe(true);
      expect(resolveForward('abc123')).toBe('def456');
      expect(getForwardMap().size).toBe(1);
    });

    it('records eviction', () => {
      recordEviction('abc123', 'src/foo.ts', 'stale_hash', 5);
      expect(getEvictionMap().size).toBe(1);
      expect(getEvictionMap().get('abc123')?.cause).toBe('stale_hash');
    });

    it('skips eviction if forward already exists for that hash', () => {
      recordForwarding('abc123', 'def456', 'src/foo.ts', 'hash_forward', 5);
      recordEviction('abc123', 'src/foo.ts', 'stale_hash', 5);
      expect(getEvictionMap().size).toBe(0);
    });

    it('clears forwarding', () => {
      recordForwarding('abc123', 'def456', 'src/foo.ts', 'hash_forward', 5);
      clearForward('abc123');
      expect(hasForward('abc123')).toBe(false);
      expect(getForwardMap().size).toBe(0);
    });

    it('clears eviction', () => {
      recordEviction('abc123', 'src/foo.ts', 'stale_hash', 5);
      clearEviction('abc123');
      expect(getEvictionMap().size).toBe(0);
    });
  });

  describe('pruning', () => {
    it('prunes entries older than maxAge with no recent reference', () => {
      recordForwarding('old1', 'new1', 'src/a.ts', 'hash_forward', 1);
      recordEviction('old2', 'src/b.ts', 'stale_hash', 1);
      recordForwarding('recent', 'new2', 'src/c.ts', 'hash_forward', 8);

      pruneStaleEntries(10, 5);

      expect(hasForward('old1')).toBe(false);
      expect(getEvictionMap().has('old2')).toBe(false);
      expect(hasForward('recent')).toBe(true);
    });

    it('keeps old entries that appear in recentHashes', () => {
      recordForwarding('old1', 'new1', 'src/a.ts', 'hash_forward', 1);
      const recent = new Set(['old1']);

      pruneStaleEntries(10, 5, recent);

      expect(hasForward('old1')).toBe(true);
    });
  });

  describe('formatHashManifest', () => {
    it('renders empty manifest', () => {
      const output = formatHashManifest({
        activeChunks: [],
        dematRefs: [],
        archivedRefs: [],
        turn: 1,
      });
      expect(output).toContain('## HASH MANIFEST');
      expect(output).toContain('turn 1');
      expect(output).toContain('all fresh');
      expect(output).not.toContain('_Legend:');
    });

    it('renders active chunks with pin flags and freshness', () => {
      const output = formatHashManifest({
        activeChunks: [
          { shortHash: 'abc123', type: 'file', source: 'src/foo.ts', tokens: 1200, pinned: true, freshness: 'fresh' },
          { shortHash: 'def456', type: 'smart', source: 'src/bar.ts', tokens: 800, pinned: true, pinnedShape: 'sig', freshness: 'fresh' },
          { shortHash: 'ghi789', type: 'file', source: 'src/baz.ts', tokens: 400, suspectSince: Date.now(), freshness: 'suspect', freshnessCause: 'watcher_event' },
        ],
        dematRefs: [],
        archivedRefs: [],
        turn: 5,
      });
      expect(output).toContain('h:abc123');
      expect(output).toContain('P');
      expect(output).toContain('src/foo.ts');
      expect(output).toContain('1.2k');
      expect(output).toContain('fresh');
      expect(output).toContain('P:sig');
      expect(output).toContain('suspect (watcher_event)');
      expect(output).toContain('3 active');
      expect(output).toContain('1 suspect');
      expect(output).not.toContain('_Legend:');
    });

    it('maps fileview type column to fv', () => {
      const output = formatHashManifest({
        activeChunks: [
          { shortHash: 'a1b2c3', type: 'fileview', source: 'src/app.tsx', tokens: 529, pinned: true, pinnedShape: 'sig', freshness: 'fresh' },
        ],
        dematRefs: [],
        archivedRefs: [],
        turn: 5,
      });
      expect(output).toMatch(/h:a1b2c3\s+P:sig\s+fv\s+/);
      expect(output).not.toContain('fileview');
    });

    it('formatManifestType maps fileview to fv width', () => {
      expect(formatManifestType('fileview')).toBe('fv    ');
      expect(formatManifestType('file')).toBe('file  ');
    });

    it('renders dematerialized and archived refs', () => {
      const output = formatHashManifest({
        activeChunks: [],
        dematRefs: [makeRef({ shortHash: 'aaa111', source: 'src/warm.ts', tokens: 500 })],
        archivedRefs: [makeRef({ shortHash: 'bbb222', source: 'src/cold.ts', tokens: 900, visibility: 'archived' })],
        turn: 3,
      });
      expect(output).toContain('h:aaa111');
      expect(output).toContain('demat');
      expect(output).toContain('h:bbb222');
      expect(output).toContain('arch');
      expect(output).toContain('rec to restore');
      expect(output).not.toContain('_Legend:');
    });

    it('renders superseded-by-slices marker when chunk carries supersededBy', () => {
      const output = formatHashManifest({
        activeChunks: [
          { shortHash: 'abc123', type: 'file', source: 'src/big.ts', tokens: 4200, pinned: false, freshness: 'fresh',
            supersededBy: { hashes: ['aaa111', 'bbb222'], note: 'slices' } },
        ],
        dematRefs: [],
        archivedRefs: [],
        turn: 7,
      });
      expect(output).toContain('h:abc123');
      expect(output).toContain('| superseded by slices: h:aaa111, h:bbb222');
    });

    it('caps supersededBy hash list with a `+N more` overflow marker', () => {
      const output = formatHashManifest({
        activeChunks: [
          { shortHash: 'abc123', type: 'file', source: 'src/big.ts', tokens: 4200, freshness: 'fresh',
            supersededBy: { hashes: ['h1', 'h2', 'h3', 'h4', 'h5'], note: 'slices' } },
        ],
        dematRefs: [],
        archivedRefs: [],
        turn: 7,
      });
      expect(output).toContain('h:h1, h:h2, h:h3 +2 more');
    });

    it('omits marker when supersededBy is undefined (forward-compat with old snapshots)', () => {
      const output = formatHashManifest({
        activeChunks: [
          { shortHash: 'abc123', type: 'file', source: 'src/big.ts', tokens: 4200, freshness: 'fresh' },
        ],
        dematRefs: [],
        archivedRefs: [],
        turn: 7,
      });
      expect(output).not.toContain('superseded by');
    });

    it('renders forward and eviction rows', () => {
      recordForwarding('old111', 'new222', 'src/edited.ts', 'edit-refresh', 4);
      recordEviction('gone33', 'src/deleted.ts', 'reconcile', 3);

      const output = formatHashManifest({
        activeChunks: [],
        dematRefs: [],
        archivedRefs: [],
        turn: 5,
      });
      expect(output).toContain('h:old111 -> h:new222');
      expect(output).toContain('edit-refresh');
      expect(output).toContain('h:gone33');
      expect(output).toContain('evict');
      expect(output).toContain('reconcile');
      expect(output).not.toContain('_Legend:');
    });
  });

  describe('getManifestMetrics', () => {
    it('returns correct counts', () => {
      recordForwarding('a', 'b', 'x', 'fwd', 1);
      recordEviction('c', 'y', 'stale', 1);

      const metrics = getManifestMetrics({
        activeChunks: [
          { shortHash: '111111', type: 'file', source: 'a.ts', tokens: 100, freshness: 'fresh' },
          { shortHash: '222222', type: 'file', source: 'b.ts', tokens: 200, suspectSince: 1, freshness: 'suspect' },
        ],
        dematRefs: [makeRef()],
        archivedRefs: [makeRef(), makeRef()],
        turn: 3,
      });

      expect(metrics.active).toBe(2);
      expect(metrics.demat).toBe(1);
      expect(metrics.archived).toBe(2);
      expect(metrics.forwarded).toBe(1);
      expect(metrics.suspect).toBe(1);
      expect(metrics.evicted).toBe(1);
    });
  });

  describe('pin flag after auto-unpin', () => {
    it('renders no P flag for an unpinned chunk', () => {
      const output = formatHashManifest({
        activeChunks: [
          { shortHash: 'aaa111', type: 'file', source: 'src/large.ts', tokens: 500, pinned: false },
        ],
        dematRefs: [],
        archivedRefs: [],
        turn: 3,
      });
      expect(output).toContain('h:aaa111');
      expect(output).not.toMatch(/h:aaa111\s+P/);
    });

    it('renders P flag for a pinned chunk and no P after unpin', () => {
      const pinnedOutput = formatHashManifest({
        activeChunks: [
          { shortHash: 'bbb222', type: 'file', source: 'src/large.ts', tokens: 500, pinned: true },
        ],
        dematRefs: [],
        archivedRefs: [],
        turn: 2,
      });
      expect(pinnedOutput).toMatch(/h:bbb222\s+P/);

      const unpinnedOutput = formatHashManifest({
        activeChunks: [
          { shortHash: 'bbb222', type: 'file', source: 'src/large.ts', tokens: 500, pinned: false },
        ],
        dematRefs: [],
        archivedRefs: [],
        turn: 3,
      });
      expect(unpinnedOutput).not.toMatch(/h:bbb222\s+P/);
    });
  });
});
